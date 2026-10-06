// Character skin bundles the user imports: a manifest and some PNG layers, kept
// under %LOCALAPPDATA%\Coucou\skins\<id>\. A bundle is data only — it can never
// run code — and everything in it is checked before a single byte is kept.
// The page draws it (src/mochi/bundles.ts); this file only vets, stores and serves.

use std::io::Read;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::settings;

/// Every limit is far above a real skin and far below anything that hurts.
const MAX_MANIFEST: usize = 256 * 1024;
const MAX_LAYER: usize = 8 * 1024 * 1024;
const MAX_TOTAL: usize = 32 * 1024 * 1024;
const MAX_FILES: usize = 24;
/// Decoded, a 4096² layer is 64 MB: no layer needs more.
const MAX_SIDE: u32 = 4096;
const MAX_PERSONA: usize = 2000;
const RESERVED: [&str; 2] = ["mochi", "ribbon"];

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SkinInfo {
    pub id: String,
    pub name: String,
    pub author: String,
    pub note: String,
    pub persona: String,
}

pub fn skins_dir() -> PathBuf {
    settings::local_dir().join("skins")
}

pub fn valid_id(id: &str) -> bool {
    let mut chars = id.chars();
    id.len() <= 32
        && chars.next().is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// A file name that is just a name: no folders, no `..`, nothing hidden.
fn flat_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && !name.starts_with('.')
        && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
}

fn is_png(bytes: &[u8]) -> Result<(), String> {
    if bytes.len() < 24 || bytes[..8] != [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a] {
        return Err("a layer is not a PNG picture".into());
    }
    let w = u32::from_be_bytes([bytes[16], bytes[17], bytes[18], bytes[19]]);
    let h = u32::from_be_bytes([bytes[20], bytes[21], bytes[22], bytes[23]]);
    if w == 0 || h == 0 || w > MAX_SIDE || h > MAX_SIDE {
        return Err(format!("a layer is {w}×{h}; the most is {MAX_SIDE}×{MAX_SIDE}"));
    }
    Ok(())
}

/// A validated bundle, ready to be written.
pub struct Bundle {
    pub info: SkinInfo,
    pub manifest: Vec<u8>,
    pub layers: Vec<(String, Vec<u8>)>,
}

/// Checks `(file name, bytes)` pairs and turns them into a bundle. Pure: both
/// the folder and the zip reader end up here.
pub fn vet(files: Vec<(String, Vec<u8>)>) -> Result<Bundle, String> {
    if files.len() > MAX_FILES {
        return Err(format!("too many files (at most {MAX_FILES})"));
    }
    let mut total = 0usize;
    let mut manifest = None;
    let mut layers = Vec::new();
    for (name, bytes) in files {
        if !flat_name(&name) {
            return Err(format!("\"{name}\" is not a plain file name"));
        }
        total += bytes.len();
        if total > MAX_TOTAL {
            return Err("the bundle is bigger than 32 MB".into());
        }
        if name == "manifest.json" {
            if bytes.len() > MAX_MANIFEST {
                return Err("manifest.json is too big".into());
            }
            manifest = Some(bytes);
        } else if name.to_ascii_lowercase().ends_with(".png") {
            if bytes.len() > MAX_LAYER {
                return Err(format!("\"{name}\" is bigger than 8 MB"));
            }
            is_png(&bytes).map_err(|e| format!("\"{name}\": {e}"))?;
            layers.push((name, bytes));
        } else {
            return Err(format!("\"{name}\": only manifest.json and .png files are allowed"));
        }
    }
    let manifest = manifest.ok_or("there is no manifest.json")?;
    let json: serde_json::Value =
        serde_json::from_slice(&manifest).map_err(|e| format!("manifest.json is not valid: {e}"))?;
    let text = |key: &str| json.get(key).and_then(|v| v.as_str()).unwrap_or("").trim().to_string();

    match json.get("format").and_then(|v| v.as_u64()) {
        Some(2) => {}
        Some(1) => return Err("this skin was made for the old full-figure format; make it again in the skin editor".into()),
        _ => return Err("this bundle needs a newer Kotoba (manifest format is not 2)".into()),
    }
    let id = text("id");
    if !valid_id(&id) || RESERVED.contains(&id.as_str()) {
        return Err("the id must be 1–32 characters of a–z, 0–9 and -, and not mochi or ribbon".into());
    }
    let name = text("name");
    if name.is_empty() || name.chars().count() > 40 {
        return Err("the name is missing or longer than 40 characters".into());
    }
    let persona = text("persona");
    if persona.chars().count() > MAX_PERSONA {
        return Err(format!("the persona is longer than {MAX_PERSONA} characters"));
    }
    // Every picture the manifest names has to be in the bundle.
    let wanted: Vec<&str> = json
        .get("layers")
        .and_then(|v| v.as_array())
        .ok_or("the manifest has no layers")?
        .iter()
        .filter_map(|l| l.get("src").and_then(|s| s.as_str()))
        .collect();
    if wanted.is_empty() {
        return Err("the manifest has no layers".into());
    }
    for src in wanted {
        if !layers.iter().any(|(n, _)| n == src) {
            return Err(format!("the manifest names \"{src}\" but it is not in the bundle"));
        }
    }

    Ok(Bundle {
        info: SkinInfo {
            id,
            name,
            author: text("author").chars().take(60).collect(),
            note: text("note").chars().take(300).collect(),
            persona,
        },
        manifest,
        layers,
    })
}

// ── Reading a bundle from disk ────────────────────────────────────────────────

fn read_folder(dir: &Path) -> Result<Vec<(String, Vec<u8>)>, String> {
    let mut out = Vec::new();
    for entry in std::fs::read_dir(dir).map_err(|e| format!("cannot read the folder: {e}"))?.flatten() {
        // symlink_metadata: a link is never followed, so it can't point elsewhere.
        let meta = entry.path().symlink_metadata().map_err(|e| e.to_string())?;
        if !meta.is_file() {
            continue;
        }
        if meta.len() as usize > MAX_LAYER.max(MAX_MANIFEST) {
            return Err(format!("\"{}\" is too big", entry.file_name().to_string_lossy()));
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        // Notes and licences may sit beside the skin; they are not part of it.
        if !name.ends_with(".png") && name != "manifest.json" {
            continue;
        }
        out.push((name, std::fs::read(entry.path()).map_err(|e| e.to_string())?));
    }
    Ok(out)
}

fn read_zip(path: &Path) -> Result<Vec<(String, Vec<u8>)>, String> {
    let file = std::fs::File::open(path).map_err(|e| format!("cannot open it: {e}"))?;
    let mut zip = zip::ZipArchive::new(file).map_err(|_| "that is not a zip file".to_string())?;
    if zip.len() > MAX_FILES * 4 {
        return Err("the zip holds too many entries".into());
    }
    let mut entries: Vec<(String, Vec<u8>)> = Vec::new();
    for i in 0..zip.len() {
        let entry = zip.by_index(i).map_err(|e| e.to_string())?;
        if entry.is_dir() {
            continue;
        }
        // enclosed_name is None for `..` and absolute paths: refuse the whole zip.
        let Some(path) = entry.enclosed_name() else {
            return Err("the zip has an unsafe file path".into());
        };
        if entry.is_symlink() {
            return Err("the zip contains a link".into());
        }
        let name = path.to_string_lossy().replace('\\', "/");
        if name.starts_with("__MACOSX/") || name.ends_with(".DS_Store") || name.ends_with("Thumbs.db") {
            continue;
        }
        if entry.size() as usize > MAX_LAYER.max(MAX_MANIFEST) {
            return Err(format!("\"{name}\" is too big"));
        }
        let mut bytes = Vec::new();
        entry
            .take(MAX_LAYER.max(MAX_MANIFEST) as u64 + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())?;
        entries.push((name, bytes));
    }
    // A zip made from a folder usually has that folder as its only top level.
    let manifest = entries
        .iter()
        .find(|(n, _)| n == "manifest.json" || n.ends_with("/manifest.json") && n.matches('/').count() == 1)
        .map(|(n, _)| n.clone())
        .ok_or("there is no manifest.json")?;
    let prefix = manifest.strip_suffix("manifest.json").unwrap_or("").to_string();
    Ok(entries
        .into_iter()
        .filter(|(n, _)| n.starts_with(&prefix))
        .map(|(n, b)| (n[prefix.len()..].to_string(), b))
        .collect())
}

/// Vets a bundle and, when `keep` is set, stores it. Without `keep` nothing is
/// written: Settings shows what is in it first and asks.
pub fn import(source: &str, keep: bool) -> Result<SkinInfo, String> {
    let path = Path::new(source);
    let files = if path.is_dir() {
        read_folder(path)?
    } else {
        read_zip(path)?
    };
    let bundle = vet(files)?;
    if keep {
        install(bundle)
    } else {
        Ok(bundle.info)
    }
}

/// Writes next to the final place and renames, so a half-written skin is never listed.
fn install(bundle: Bundle) -> Result<SkinInfo, String> {
    let root = skins_dir();
    std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    let tmp = root.join(format!(".incoming-{}", bundle.info.id));
    let _ = std::fs::remove_dir_all(&tmp);
    std::fs::create_dir_all(&tmp).map_err(|e| e.to_string())?;
    let write = || -> std::io::Result<()> {
        std::fs::write(tmp.join("manifest.json"), &bundle.manifest)?;
        for (name, bytes) in &bundle.layers {
            std::fs::write(tmp.join(name), bytes)?;
        }
        Ok(())
    };
    if let Err(e) = write() {
        let _ = std::fs::remove_dir_all(&tmp);
        return Err(format!("cannot save the skin: {e}"));
    }
    let dest = root.join(&bundle.info.id);
    let _ = std::fs::remove_dir_all(&dest);
    std::fs::rename(&tmp, &dest).map_err(|e| format!("cannot save the skin: {e}"))?;
    Ok(bundle.info)
}

// ── Saving from the skin editor ───────────────────────────────────────────────

fn base64_decode(s: &str) -> Result<Vec<u8>, String> {
    let val = |c: u8| -> Option<u32> {
        Some(match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            _ => return None,
        } as u32)
    };
    let bytes: Vec<u8> = s.bytes().filter(|c| !c.is_ascii_whitespace()).collect();
    let body = bytes.strip_suffix(b"==").or_else(|| bytes.strip_suffix(b"=")).unwrap_or(&bytes);
    let mut out = Vec::with_capacity(body.len() * 3 / 4);
    for chunk in body.chunks(4) {
        let mut n = 0u32;
        for (i, &c) in chunk.iter().enumerate() {
            n |= val(c).ok_or("a picture could not be read")? << (18 - 6 * i);
        }
        out.push((n >> 16) as u8);
        if chunk.len() > 2 {
            out.push((n >> 8) as u8);
        }
        if chunk.len() > 3 {
            out.push(n as u8);
        }
    }
    Ok(out)
}

/// What the skin editor made: `(file name, base64 bytes)` pairs. Checked exactly
/// like an import, then installed — or, with `zip_path`, written as a .zip to
/// share instead.
pub fn save(files: Vec<(String, String)>, zip_path: Option<&str>) -> Result<SkinInfo, String> {
    let decoded = files
        .into_iter()
        .map(|(name, data)| Ok((name, base64_decode(&data)?)))
        .collect::<Result<Vec<_>, String>>()?;
    let bundle = vet(decoded)?;
    match zip_path {
        None => install(bundle),
        Some(path) => {
            write_zip(Path::new(path), &bundle)?;
            Ok(bundle.info)
        }
    }
}

fn write_zip(path: &Path, bundle: &Bundle) -> Result<(), String> {
    use std::io::Write;
    let err = |e: &dyn std::fmt::Display| format!("cannot write the zip: {e}");
    let file = std::fs::File::create(path).map_err(|e| err(&e))?;
    let mut zip = zip::ZipWriter::new(file);
    // PNGs are compressed already: storing them is as small and much simpler.
    let opts = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    let mut put = |name: &str, bytes: &[u8]| -> Result<(), String> {
        zip.start_file(name, opts).map_err(|e| err(&e))?;
        zip.write_all(bytes).map_err(|e| err(&e))
    };
    put("manifest.json", &bundle.manifest)?;
    for (name, bytes) in &bundle.layers {
        put(name, bytes)?;
    }
    zip.finish().map_err(|e| err(&e))?;
    Ok(())
}

// ── Listing, serving, removing ────────────────────────────────────────────────

pub fn list() -> Vec<SkinInfo> {
    let Ok(dirs) = std::fs::read_dir(skins_dir()) else { return Vec::new() };
    let mut skins: Vec<SkinInfo> = dirs
        .flatten()
        .filter_map(|d| {
            let id = d.file_name().to_string_lossy().into_owned();
            if !valid_id(&id) {
                return None;
            }
            let files = read_folder(&d.path()).ok()?;
            vet(files).ok().map(|b| b.info).filter(|i| i.id == id)
        })
        .collect();
    skins.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    skins
}

/// Raw text of an installed skin's manifest.
pub fn manifest(id: &str) -> Result<String, String> {
    if !valid_id(id) {
        return Err("unknown skin".into());
    }
    std::fs::read_to_string(skins_dir().join(id).join("manifest.json")).map_err(|_| "unknown skin".into())
}

/// One layer picture of an installed skin.
pub fn layer(id: &str, name: &str) -> Result<Vec<u8>, String> {
    if !valid_id(id) || !flat_name(name) || !name.ends_with(".png") {
        return Err("unknown layer".into());
    }
    std::fs::read(skins_dir().join(id).join(name)).map_err(|_| "unknown layer".into())
}

pub fn remove(id: &str) -> Result<(), String> {
    if !valid_id(id) {
        return Err("unknown skin".into());
    }
    let dir = skins_dir().join(id);
    if dir.is_dir() {
        std::fs::remove_dir_all(dir).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn png(w: u32, h: u32) -> Vec<u8> {
        let mut b = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, b'I', b'H', b'D', b'R'];
        b.extend(w.to_be_bytes());
        b.extend(h.to_be_bytes());
        b
    }

    fn manifest(extra: &str) -> Vec<u8> {
        format!(r#"{{"format":2,"id":"demo","name":"Demo","layers":[{{"id":"head","src":"head.png"}}]{extra}}}"#).into_bytes()
    }

    fn good() -> Vec<(String, Vec<u8>)> {
        vec![("manifest.json".into(), manifest("")), ("head.png".into(), png(64, 64))]
    }

    #[test]
    fn a_valid_bundle_passes() {
        let b = vet(good()).unwrap();
        assert_eq!((b.info.id.as_str(), b.info.name.as_str()), ("demo", "Demo"));
        assert_eq!(b.layers.len(), 1);
    }

    #[test]
    fn refuses_the_old_full_figure_format() {
        let m = br#"{"format":1,"id":"old","name":"Old","layers":[{"src":"head.png"}]}"#.to_vec();
        let err = vet(vec![("manifest.json".into(), m), ("head.png".into(), png(8, 8))]).err().unwrap();
        assert!(err.contains("old full-figure format"), "{err}");
    }

    #[test]
    fn refuses_what_is_not_a_plain_picture_or_manifest() {
        let mut f = good();
        f.push(("evil.js".into(), b"x".to_vec()));
        assert!(vet(f).is_err());
        let mut f = good();
        f.push(("../evil.png".into(), png(8, 8)));
        assert!(vet(f).is_err());
        let mut f = good();
        f[1].1 = b"not a png at all, not at all...".to_vec();
        assert!(vet(f).is_err());
        let mut f = good();
        f[1].1 = png(9000, 10);
        assert!(vet(f).is_err());
    }

    #[test]
    fn refuses_big_or_inconsistent_bundles() {
        let mut f = good();
        f[1].1 = {
            let mut p = png(8, 8);
            p.resize(MAX_LAYER + 1, 0);
            p
        };
        assert!(vet(f).is_err());
        // The manifest names a picture that isn't there.
        let f = vec![("manifest.json".into(), manifest("")), ("other.png".into(), png(8, 8))];
        assert!(vet(f).is_err());
        // Bad ids, and the built-in names.
        for id in ["Demo", "mochi", "ribbon", "a b", ""] {
            let m = format!(r#"{{"format":2,"id":"{id}","name":"x","layers":[{{"src":"head.png"}}]}}"#);
            assert!(vet(vec![("manifest.json".into(), m.into_bytes()), ("head.png".into(), png(8, 8))]).is_err(), "{id}");
        }
        let long = "x".repeat(MAX_PERSONA + 1);
        let f = vec![("manifest.json".into(), manifest(&format!(r#","persona":"{long}""#))), ("head.png".into(), png(8, 8))];
        assert!(vet(f).is_err());
    }

    fn make_zip(path: &Path, entries: &[(&str, Vec<u8>)]) {
        let mut zip = zip::ZipWriter::new(std::fs::File::create(path).unwrap());
        let opts = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
        for (name, bytes) in entries {
            zip.start_file(*name, opts).unwrap();
            zip.write_all(bytes).unwrap();
        }
        zip.finish().unwrap();
    }

    #[test]
    fn zips_are_read_with_or_without_a_top_folder_and_slip_is_refused() {
        let tmp = std::env::temp_dir().join(format!("coucou-skins-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();

        let flat = tmp.join("flat.zip");
        make_zip(&flat, &[("manifest.json", manifest("")), ("head.png", png(8, 8))]);
        assert!(vet(read_zip(&flat).unwrap()).is_ok());

        let nested = tmp.join("nested.zip");
        make_zip(&nested, &[("demo/manifest.json", manifest("")), ("demo/head.png", png(8, 8))]);
        assert!(vet(read_zip(&nested).unwrap()).is_ok());

        let slip = tmp.join("slip.zip");
        make_zip(&slip, &[("manifest.json", manifest("")), ("head.png", png(8, 8)), ("../evil.png", png(8, 8))]);
        assert!(read_zip(&slip).is_err());

        assert!(read_zip(&tmp.join("missing.zip")).is_err());
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn base64_round_trips_and_editor_zips_read_back() {
        let png = png(16, 16);
        for bytes in [png.clone(), vec![1], vec![1, 2], vec![1, 2, 3]] {
            assert_eq!(base64_decode(&crate::claude::base64_for(&bytes)).unwrap(), bytes);
        }
        assert!(base64_decode("@@@@").is_err());

        let tmp = std::env::temp_dir().join(format!("coucou-skin-save-{}.zip", std::process::id()));
        let files = vec![
            ("manifest.json".to_string(), crate::claude::base64_for(&manifest(""))),
            ("head.png".to_string(), crate::claude::base64_for(&png)),
        ];
        let info = save(files, Some(tmp.to_str().unwrap())).unwrap();
        assert_eq!(info.id, "demo");
        assert!(vet(read_zip(&tmp).unwrap()).is_ok());
        let _ = std::fs::remove_file(&tmp);
    }

    #[test]
    fn ids_and_layer_names_cannot_leave_the_skins_folder() {
        assert!(layer("../x", "head.png").is_err());
        assert!(layer("demo", "../head.png").is_err());
        assert!(layer("demo", "head.txt").is_err());
        assert!(remove("../..").is_err());
        assert!(super::manifest("a/b").is_err());
    }
}
