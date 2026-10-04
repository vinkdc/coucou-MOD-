// Snip: Windows' own snipping overlay (the one Win+Shift+S opens), with the
// result handed to the island like a dropped file.
//
// The overlay puts the snip on the clipboard, so it stays there to paste
// anywhere else too. We watch the clipboard's sequence number, which is just a
// counter, and only for a short while after the user asked for a snip; once
// it changes and holds a picture, the picture is saved into the inbox as PNG
// and the island is told. Nothing runs before the click or after the snip.

#[cfg(windows)]
use std::time::{Duration, Instant};

use tauri::AppHandle;
#[cfg(windows)]
use tauri::Emitter;

#[cfg(windows)]
use crate::island::WINDOW_LABEL;

/// How long a snip may take before we stop waiting for it.
#[cfg(windows)]
const WAIT: Duration = Duration::from_secs(90);
#[cfg(windows)]
const STEP: Duration = Duration::from_millis(200);

static BUSY: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Opens the snipping overlay and waits for its result in the background.
/// The island hears `snip-ready` with the saved file, or `snip-ended` if
/// nothing came (cancelled, or something other than a picture was copied).
pub fn start(app: &AppHandle) -> Result<(), String> {
    use std::sync::atomic::Ordering;
    if BUSY.swap(true, Ordering::SeqCst) {
        return Ok(()); // already waiting for one
    }
    let result = run(app);
    if result.is_err() {
        BUSY.store(false, Ordering::SeqCst);
    }
    result
}

#[cfg(windows)]
fn run(app: &AppHandle) -> Result<(), String> {
    use std::sync::atomic::Ordering;
    let before = crate::platform::clipboard_sequence();
    crate::platform::launch_app("ms-screenclip:").map_err(|_| "Windows couldn't open the snipping tool.".to_string())?;
    let app = app.clone();
    std::thread::spawn(move || {
        let started = Instant::now();
        let mut outcome = None;
        while started.elapsed() < WAIT {
            std::thread::sleep(STEP);
            if crate::platform::clipboard_sequence() == before {
                continue;
            }
            // Something was copied. A picture ends the wait; anything else
            // (text copied meanwhile) does not.
            if let Some((w, h, rgb)) = crate::platform::clipboard_image() {
                let png = crate::assistant::encode_png(w, h, &rgb);
                outcome = Some(crate::files::ingest_bytes(&snip_name(), &png));
                break;
            }
        }
        BUSY.store(false, Ordering::SeqCst);
        match outcome {
            Some(Ok(file)) => {
                crate::log::line(format!("snip: saved {} ({} bytes)", file.name, file.size));
                let _ = app.emit_to(WINDOW_LABEL, "snip-ready", file);
            }
            Some(Err(err)) => {
                crate::log::line(format!("snip: could not save ({err})"));
                let _ = app.emit_to(WINDOW_LABEL, "snip-ended", err);
            }
            None => {
                let _ = app.emit_to(WINDOW_LABEL, "snip-ended", String::new());
            }
        }
    });
    Ok(())
}

#[cfg(not(windows))]
fn run(_app: &AppHandle) -> Result<(), String> {
    Err("Snipping is only available on Windows for now.".into())
}

/// "Snip 2026-10-04 16.05.12.png", in local time.
#[cfg_attr(not(windows), allow(dead_code))]
fn snip_name() -> String {
    let t = crate::platform::local_time();
    format!(
        "Snip {:04}-{:02}-{:02} {:02}.{:02}.{:02}.png",
        t.year, t.month, t.day, t.hour, t.minute, t.second
    )
}

/// A packed device-independent bitmap (CF_DIB) to RGB8, top row first.
/// 24- and 32-bit only, which is what screen captures are; anything else,
/// or a buffer too short for what its header claims, is `None`.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn dib_to_rgb(dib: &[u8]) -> Option<(u32, u32, Vec<u8>)> {
    let u32_at = |o: usize| dib.get(o..o + 4).map(|b| u32::from_le_bytes([b[0], b[1], b[2], b[3]]));
    let i32_at = |o: usize| u32_at(o).map(|v| v as i32);
    let u16_at = |o: usize| dib.get(o..o + 2).map(|b| u16::from_le_bytes([b[0], b[1]]));

    let header = u32_at(0)? as usize;
    let width = i32_at(4)?;
    let height = i32_at(8)?;
    let bpp = u16_at(14)?;
    let compression = u32_at(16)?;
    if width <= 0 || height == 0 || !(bpp == 24 || bpp == 32) {
        return None;
    }
    // BI_RGB (0), or BI_BITFIELDS (3) with the standard masks; with the old
    // 40-byte header the three masks follow it.
    let masks = if compression == 3 && header == 40 { 12 } else { 0 };
    if compression != 0 && compression != 3 {
        return None;
    }
    let (w, h) = (width as usize, height.unsigned_abs() as usize);
    if w > 20_000 || h > 20_000 {
        return None;
    }
    let stride = (w * bpp as usize).div_ceil(32) * 4;
    let start = header + masks;
    let pixels = dib.get(start..start + stride * h)?;
    let step = bpp as usize / 8;
    let mut rgb = Vec::with_capacity(w * h * 3);
    for row in 0..h {
        // Positive height: stored bottom row first.
        let src = if height > 0 { h - 1 - row } else { row };
        let line = &pixels[src * stride..src * stride + w * step];
        for px in line.chunks_exact(step) {
            rgb.extend_from_slice(&[px[2], px[1], px[0]]);
        }
    }
    Some((w as u32, h as u32, rgb))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dib(width: i32, height: i32, bpp: u16, pixels: &[u8]) -> Vec<u8> {
        let mut d = Vec::new();
        d.extend_from_slice(&40u32.to_le_bytes());
        d.extend_from_slice(&width.to_le_bytes());
        d.extend_from_slice(&height.to_le_bytes());
        d.extend_from_slice(&1u16.to_le_bytes());
        d.extend_from_slice(&bpp.to_le_bytes());
        d.extend_from_slice(&0u32.to_le_bytes());
        d.extend_from_slice(&[0u8; 20]);
        d.extend_from_slice(pixels);
        d
    }

    #[test]
    fn bottom_up_32_bit_comes_out_top_row_first_as_rgb() {
        // 1×2, BGRA: bottom row blue, top row red.
        let d = dib(1, 2, 32, &[255, 0, 0, 255, 0, 0, 255, 255]);
        let (w, h, rgb) = dib_to_rgb(&d).unwrap();
        assert_eq!((w, h), (1, 2));
        assert_eq!(rgb, vec![255, 0, 0, 0, 0, 255]);
    }

    #[test]
    fn rows_of_24_bit_are_padded_to_four_bytes() {
        // 1×1, BGR + one padding byte.
        let d = dib(1, -1, 24, &[10, 20, 30, 0]);
        assert_eq!(dib_to_rgb(&d).unwrap().2, vec![30, 20, 10]);
    }

    #[test]
    fn truncated_or_unsupported_bitmaps_are_refused() {
        assert!(dib_to_rgb(&dib(4, 4, 32, &[0; 8])).is_none());
        assert!(dib_to_rgb(&dib(1, 1, 8, &[0; 4])).is_none());
        assert!(dib_to_rgb(&[1, 2, 3]).is_none());
    }
}
