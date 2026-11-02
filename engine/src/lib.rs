//! TavernGym for the browser: a plain C ABI over WebAssembly, no bindgen.
//!
//! Strings cross as UTF-8 in linear memory. JS allocates input with `tg_alloc`, calls a
//! function, and reads the output from `tg_out_ptr()` / `tg_out_len()` (valid until the next
//! call). Functions return 0 on success and 1 on error (the output then holds the message).
//! Games live in a handle table; each Web Worker has its own instance, so no locking.

use std::cell::RefCell;

use taverngym::{Game, RulesConfig};

thread_local! {
    static OUT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
    static GAMES: RefCell<Vec<Option<Game>>> = const { RefCell::new(Vec::new()) };
}

fn set_out(s: &str) {
    OUT.with(|o| {
        let mut o = o.borrow_mut();
        o.clear();
        o.extend_from_slice(s.as_bytes());
    });
}

fn done(r: Result<String, String>) -> u32 {
    match r {
        Ok(s) => {
            set_out(&s);
            0
        }
        Err(e) => {
            set_out(&e);
            1
        }
    }
}

/// # Safety
/// `ptr..ptr+len` must be memory JS wrote through `tg_alloc`.
unsafe fn arg<'a>(ptr: *const u8, len: usize) -> Result<&'a str, String> {
    if len == 0 {
        return Ok("");
    }
    let bytes = unsafe { std::slice::from_raw_parts(ptr, len) };
    std::str::from_utf8(bytes).map_err(|e| e.to_string())
}

fn with_game<T>(h: u32, f: impl FnOnce(&mut Game) -> Result<T, String>) -> Result<T, String> {
    GAMES.with(|gs| {
        let mut gs = gs.borrow_mut();
        let g = gs
            .get_mut(h as usize)
            .and_then(|g| g.as_mut())
            .ok_or_else(|| format!("no game {h}"))?;
        f(g)
    })
}

fn store(g: Game) -> String {
    GAMES.with(|gs| {
        let mut gs = gs.borrow_mut();
        if let Some(i) = gs.iter().position(|g| g.is_none()) {
            gs[i] = Some(g);
            i.to_string()
        } else {
            gs.push(Some(g));
            (gs.len() - 1).to_string()
        }
    })
}

fn check_seat(g: &Game, p: u32) -> Result<usize, String> {
    let p = p as usize;
    if p < g.players.len() { Ok(p) } else { Err(format!("seat {p} out of range")) }
}

#[unsafe(no_mangle)]
pub extern "C" fn tg_alloc(len: usize) -> *mut u8 {
    let mut v = Vec::<u8>::with_capacity(len.max(1));
    let p = v.as_mut_ptr();
    std::mem::forget(v);
    p
}

/// # Safety
/// `ptr`/`len` must come from `tg_alloc(len)`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn tg_free(ptr: *mut u8, len: usize) {
    drop(unsafe { Vec::from_raw_parts(ptr, 0, len.max(1)) });
}

#[unsafe(no_mangle)]
pub extern "C" fn tg_out_ptr() -> *const u8 {
    OUT.with(|o| o.borrow().as_ptr())
}

#[unsafe(no_mangle)]
pub extern "C" fn tg_out_len() -> usize {
    OUT.with(|o| o.borrow().len())
}

/// New game; output = handle. An empty config means the default rules.
///
/// # Safety
/// See [`arg`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn tg_game_new(seed: u64, cfg: *const u8, cfg_len: usize) -> u32 {
    done((|| {
        let cfg = unsafe { arg(cfg, cfg_len)? };
        let rules = if cfg.is_empty() { RulesConfig::default() } else { RulesConfig::from_json(cfg)? };
        Ok(store(Game::new(seed, rules)))
    })())
}

/// Game from `state_json`; output = handle.
///
/// # Safety
/// See [`arg`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn tg_game_from_json(s: *const u8, len: usize) -> u32 {
    done((|| {
        let s = unsafe { arg(s, len)? };
        let g: Game = serde_json::from_str(s).map_err(|e| e.to_string())?;
        g.check_loaded()?;
        Ok(store(g))
    })())
}

#[unsafe(no_mangle)]
pub extern "C" fn tg_game_free(h: u32) {
    GAMES.with(|gs| {
        if let Some(g) = gs.borrow_mut().get_mut(h as usize) {
            *g = None;
        }
    });
}

#[unsafe(no_mangle)]
pub extern "C" fn tg_game_copy(h: u32) -> u32 {
    done(with_game(h, |g| Ok(g.clone())).map(store))
}

/// Copy of `g` with seat `p`'s warband in `order` (each index of the current board once).
fn reordered(g: &Game, p: u32, order: &[u8]) -> Result<Game, String> {
    let p = check_seat(g, p)?;
    let n = g.players[p].board.len();
    if order.len() != n {
        return Err(format!("order has {} minions, the warband {n}", order.len()));
    }
    let mut seen = vec![false; n];
    for &i in order {
        let i = i as usize;
        if i >= n || seen[i] {
            return Err(format!("bad order {order:?}"));
        }
        seen[i] = true;
    }
    let mut copy = g.clone();
    let board = &g.players[p].board;
    copy.players[p].board = order.iter().map(|&i| board[i as usize].clone()).collect();
    Ok(copy)
}

/// Copy of game `h` with seat `p`'s warband rearranged: `order[k]` is the index (in the current
/// warband) of the minion to put at slot k. Output = handle of the copy. Same game as dumping
/// the state, moving the minions in the JSON and loading it again, without the JSON.
///
/// # Safety
/// `order..order+len` must be memory JS wrote through `tg_alloc`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn tg_game_reordered(h: u32, p: u32, order: *const u8, len: usize) -> u32 {
    let order: &[u8] = if len == 0 { &[] } else { unsafe { std::slice::from_raw_parts(order, len) } };
    done(with_game(h, |g| reordered(g, p, order)).map(store))
}

#[unsafe(no_mangle)]
pub extern "C" fn tg_state_json(h: u32) -> u32 {
    done(with_game(h, |g| serde_json::to_string(g).map_err(|e| e.to_string())))
}

#[unsafe(no_mangle)]
pub extern "C" fn tg_view(h: u32, p: u32) -> u32 {
    done(with_game(h, |g| {
        let p = check_seat(g, p)?;
        Ok(taverngym::debug::view(g, p).to_string())
    }))
}

/// Debug command as JSON (`{"cmd": "combat_preview", ...}`); output = JSON result.
///
/// # Safety
/// See [`arg`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn tg_debug(h: u32, s: *const u8, len: usize) -> u32 {
    done((|| {
        let s = unsafe { arg(s, len)? };
        let cmd: taverngym::debug::DebugCmd =
            serde_json::from_str(s).map_err(|e| format!("bad command: {e}"))?;
        with_game(h, |g| taverngym::debug::run_debug(g, cmd).map(|v| v.to_string()))
    })())
}

/// Legal-action mask of seat `p` as a string of '0'/'1'.
#[unsafe(no_mangle)]
pub extern "C" fn tg_legal_mask(h: u32, p: u32) -> u32 {
    done(with_game(h, |g| {
        let p = check_seat(g, p)?;
        Ok(g.legal_mask(p).iter().map(|&b| if b { '1' } else { '0' }).collect())
    }))
}

#[unsafe(no_mangle)]
pub extern "C" fn tg_step(h: u32, p: u32, action: u32) -> u32 {
    done(with_game(h, |g| {
        let p = check_seat(g, p)?;
        g.apply_index(p, action as usize).map(|_| String::new()).map_err(|e| e.to_string())
    }))
}

/// The card catalogue (`taverngym::debug::catalog`) as JSON.
#[unsafe(no_mangle)]
pub extern "C" fn tg_catalog() -> u32 {
    done(Ok(taverngym::debug::catalog().to_string()))
}

#[unsafe(no_mangle)]
pub extern "C" fn tg_version() -> u32 {
    done(Ok(format!("{} ({})", taverngym::VERSION, taverngym::GAME_VERSION)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn game_with_board() -> Game {
        let mut g = Game::new(7, RulesConfig::default());
        for card in ["BG_CFM_315", "BG28_300", "BG_CFM_315"] {
            let cmd = serde_json::json!({"cmd": "add_minion", "p": 0, "zone": "board", "card": card});
            let cmd: taverngym::debug::DebugCmd = serde_json::from_value(cmd).unwrap();
            taverngym::debug::run_debug(&mut g, cmd).unwrap();
        }
        g
    }

    #[test]
    fn reordered_matches_a_json_round_trip() {
        let g = game_with_board();
        assert_eq!(g.players[0].board.len(), 3);
        let copy = reordered(&g, 0, &[2, 0, 1]).unwrap();

        let mut v: serde_json::Value = serde_json::to_value(&g).unwrap();
        let b = v["players"][0]["board"].as_array().unwrap().clone();
        v["players"][0]["board"] = serde_json::Value::Array(vec![b[2].clone(), b[0].clone(), b[1].clone()]);
        let via_json: Game = serde_json::from_value(v).unwrap();

        assert_eq!(serde_json::to_string(&copy).unwrap(), serde_json::to_string(&via_json).unwrap());
        assert_eq!(serde_json::to_string(&g).unwrap(), serde_json::to_string(&game_with_board()).unwrap(),
                   "the original is left as it was");
    }

    #[test]
    fn reordered_rejects_bad_orders() {
        let g = game_with_board();
        for bad in [&[0u8, 1][..], &[0, 1, 1], &[0, 1, 3], &[0, 1, 2, 3]] {
            assert!(reordered(&g, 0, bad).is_err(), "{bad:?}");
        }
        assert!(reordered(&g, 9, &[0, 1, 2]).is_err());
    }
}
