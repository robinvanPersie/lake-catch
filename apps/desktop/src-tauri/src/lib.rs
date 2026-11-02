#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::env;
use std::fs;
use std::path::PathBuf;
use std::io::Write;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
use url::Url;

const LAKE_DATA_STORE_IDENTIFIER: [u8; 16] = [
    108, 97, 110, 104, 117, 45, 98, 114, 105, 100, 103, 101, 45, 118, 48, 49,
];

#[tauri::command]
fn app_info() -> &'static str {
    "Lake Catch P1"
}

#[derive(Debug, Deserialize, Serialize)]
struct LakeSession {
    cookies: Option<String>,
    token: Option<String>,
}

#[derive(Debug, Serialize)]
struct LakeApiSyncResult {
    status: String,
    stage: String,
    endpoint: Option<String>,
    http_status: Option<u16>,
    project_id: Option<String>,
    image_id: Option<String>,
    team_id: Option<String>,
    json_url: Option<String>,
    json_size: Option<usize>,
    root_keys: Vec<String>,
    layers: Vec<LakeLayerSummary>,
    assets: Vec<LakeAssetSummary>,
    notes: Vec<String>,
}

#[derive(Debug, Serialize, Clone)]
struct LakeLayerSummary {
    id: String,
    parent_id: Option<String>,
    name: String,
    layer_type: String,
    bounds: Option<LakeBounds>,
    text: Option<String>,
    visible: bool,
    depth: usize,
    style: Option<serde_json::Map<String, serde_json::Value>>,
    asset_url: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
struct LakeAssetSummary {
    id: String,
    name: String,
    kind: String,
    source_url: Option<String>,
    width: Option<f64>,
    height: Option<f64>,
    density: Option<String>,
    download_policy: String,
    local_path: Option<String>,
    download_status: String,
    checksum: Option<String>,
    byte_size: Option<usize>,
    mime_type: Option<String>,
    reference_count: usize,
}

#[derive(Debug, Serialize, Clone)]
struct LakeBounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

#[derive(Debug, Default)]
struct LakeRoute {
    project_id: Option<String>,
    image_id: Option<String>,
    team_id: Option<String>,
    child: Option<String>,
}

fn lake_route(raw: &str) -> Result<LakeRoute, String> {
    let url = Url::parse(raw).map_err(|_| "当前页面地址不是有效 URL".to_string())?;
    let query = url
        .fragment()
        .and_then(|fragment| fragment.split_once('?').map(|(_, query)| query))
        .or_else(|| url.query())
        .unwrap_or_default();
    let mut route = LakeRoute::default();
    for (key, value) in url::form_urlencoded::parse(query.as_bytes()) {
        match key.as_ref() {
            "pid" | "project_id" => route.project_id = Some(value.into_owned()),
            "image_id" | "docId" => route.image_id = Some(value.into_owned()),
            "tid" | "team_id" => route.team_id = Some(value.into_owned()),
            // Detail pages use both names depending on how the page was
            // opened. Omitting childImg makes the API fall back to another
            // artboard in the same project, which produces a valid but wrong
            // preview.
            "child" | "childImg" | "child_img" => route.child = Some(value.into_owned()),
            _ => {}
        }
    }
    if route.project_id.is_none() {
        return Err("当前页面 URL 缺少项目 ID（pid/project_id）".to_string());
    }
    if route.image_id.is_none() {
        return Err("当前页面 URL 缺少画板 ID（image_id）".to_string());
    }
    Ok(route)
}

fn lake_api_url(route: &LakeRoute) -> Result<Url, String> {
    let mut endpoint = Url::parse("https://lanhuapp.com/api/project/image")
        .map_err(|_| "Lake API 地址无效".to_string())?;
    {
        let mut query = endpoint.query_pairs_mut();
        query.append_pair("pid", route.project_id.as_deref().unwrap_or_default());
        query.append_pair(
            "project_id",
            route.project_id.as_deref().unwrap_or_default(),
        );
        query.append_pair("image_id", route.image_id.as_deref().unwrap_or_default());
        query.append_pair("dds_status", "1");
        query.append_pair("comment", "1");
        if let Some(team_id) = route.team_id.as_deref() {
            query.append_pair("team_id", team_id);
        }
        if let Some(child) = route.child.as_deref() {
            query.append_pair("child", child);
        }
    }
    Ok(endpoint)
}

fn response_data(value: &serde_json::Value) -> &serde_json::Value {
    value
        .get("data")
        .or_else(|| value.get("result"))
        .unwrap_or(value)
}

fn json_url(value: &serde_json::Value) -> Option<String> {
    fn walk(value: &serde_json::Value) -> Option<String> {
        match value {
            serde_json::Value::Object(map) => {
                for key in ["json_url", "jsonUrl", "jsonurl"] {
                    if let Some(url) = map.get(key).and_then(serde_json::Value::as_str) {
                        if !url.trim().is_empty() {
                            return Some(url.trim().to_string());
                        }
                    }
                }
                map.values().find_map(walk)
            }
            serde_json::Value::Array(items) => items.iter().find_map(walk),
            _ => None,
        }
    }
    walk(value)
}

fn normalize_json_url(raw: &str) -> Result<Url, String> {
    let value = if raw.starts_with("//") {
        format!("https:{raw}")
    } else if raw.starts_with("http://") || raw.starts_with("https://") {
        raw.to_string()
    } else if raw.contains('/') {
        format!("https://{raw}")
    } else {
        return Err("API 返回的 json_url 不是有效地址".to_string());
    };
    Url::parse(&value).map_err(|_| "API 返回的 json_url 不是有效地址".to_string())
}

fn json_string(value: &serde_json::Value, keys: &[&str]) -> Option<String> {
    let object = value.as_object()?;
    keys.iter().find_map(|key| {
        object
            .get(*key)
            .and_then(|item| item.as_str())
            .filter(|item| !item.trim().is_empty())
            .map(|item| item.trim().to_string())
    })
}

fn json_number(value: &serde_json::Value, keys: &[&str]) -> Option<f64> {
    let object = value.as_object()?;
    keys.iter()
        .find_map(|key| {
            object
                .get(*key)
                .and_then(|item| item.as_f64().or_else(|| item.as_str()?.parse().ok()))
        })
        .filter(|item| item.is_finite())
}

fn layer_style(value: &serde_json::Value) -> Option<serde_json::Map<String, serde_json::Value>> {
    let object = value.as_object()?;
    let mut style = serde_json::Map::new();
    let number_fields = [
        ("opacity", &["opacity"][..]),
        ("rotation", &["rotation", "rotate"][..]),
        (
            "borderRadius",
            &["borderRadius", "cornerRadius", "radius"][..],
        ),
        ("borderWidth", &["borderWidth", "strokeWidth"][..]),
        ("fontSize", &["fontSize", "textSize"][..]),
        ("fontWeight", &["fontWeight", "weight"][..]),
        ("lineHeight", &["lineHeight"][..]),
        ("letterSpacing", &["letterSpacing"][..]),
    ];
    for (name, keys) in number_fields {
        if let Some(number) = json_number(value, keys) {
            style.insert(name.to_string(), serde_json::json!(number));
        }
    }
    let string_fields = [
        ("color", &["color", "textColor", "fillColor"][..]),
        ("backgroundColor", &["backgroundColor", "bgColor"][..]),
        ("borderColor", &["borderColor", "strokeColor"][..]),
        ("textAlign", &["textAlign", "align"][..]),
        ("fontFamily", &["fontFamily", "font"][..]),
    ];
    for (name, keys) in string_fields {
        if let Some(string) = json_string(value, keys) {
            style.insert(name.to_string(), serde_json::json!(string));
        }
    }
    for container_key in [
        "style",
        "styles",
        "textStyle",
        "fill",
        "fills",
        "stroke",
        "border",
    ] {
        let Some(container) = object
            .get(container_key)
            .and_then(serde_json::Value::as_object)
        else {
            continue;
        };
        for (name, item) in container {
            if style.contains_key(name) {
                continue;
            }
            if item.is_string() || item.is_number() || item.is_boolean() {
                style.insert(name.clone(), item.clone());
            }
        }
    }
    (!style.is_empty()).then_some(style)
}

fn asset_url(value: &serde_json::Value) -> Option<String> {
    fn walk(value: &serde_json::Value) -> Option<String> {
        let object = value.as_object()?;
        if let Some(url) = json_string(
            value,
            &[
                "src",
                "url",
                "imageUrl",
                "assetUrl",
                "sourceUrl",
                "image_url",
                "asset_url",
            ],
        ) {
            return Some(url);
        }
        [
            "image",
            "bitmap",
            "asset",
            "resource",
            "fill",
            "fills",
            "backgroundImage",
        ]
        .iter()
        .filter_map(|key| object.get(*key))
        .find_map(walk)
    }
    walk(value)
}

fn density_from_token(value: &str) -> Option<String> {
    let normalized = value.trim().to_ascii_lowercase();
    let trimmed = normalized.trim_matches(|character: char| !character.is_ascii_alphanumeric());
    match trimmed {
        "mdpi" | "hdpi" | "xhdpi" | "xxhdpi" | "xxxhdpi" => Some(trimmed.to_string()),
        "1x" | "2x" | "3x" | "4x" => Some(trimmed.to_string()),
        _ => None,
    }
}

fn density_from_path(value: &str) -> Option<String> {
    let mut token = String::new();
    for character in value.chars() {
        if character.is_ascii_alphanumeric() {
            token.push(character);
        } else if let Some(density) = density_from_token(&token) {
            return Some(density);
        } else {
            token.clear();
        }
    }
    density_from_token(&token)
}

fn asset_density(
    value: &serde_json::Value,
    name: &str,
    source_url: Option<&str>,
) -> Option<String> {
    for key in ["density", "pixelDensity", "resourceDensity"] {
        if let Some(raw) = value.get(key) {
            if let Some(string) = raw.as_str().and_then(density_from_token) {
                return Some(string);
            }
            if let Some(number) = raw.as_f64().filter(|item| item.is_finite()) {
                let scale = match number {
                    1.0 => Some("1x"),
                    2.0 => Some("2x"),
                    3.0 => Some("3x"),
                    4.0 => Some("4x"),
                    _ => None,
                };
                if let Some(scale) = scale {
                    return Some(scale.to_string());
                }
            }
        }
    }
    if let Some(scale) = value.get("scale") {
        if let Some(scale) = scale.as_str().and_then(density_from_token) {
            return Some(scale);
        }
        if let Some(number) = scale.as_f64().filter(|item| item.is_finite()) {
            let scale = match number {
                1.0 => Some("1x"),
                2.0 => Some("2x"),
                3.0 => Some("3x"),
                4.0 => Some("4x"),
                _ => None,
            };
            if let Some(scale) = scale {
                return Some(scale.to_string());
            }
        }
    }
    density_from_path(name).or_else(|| source_url.and_then(density_from_path))
}

fn asset_download_policy(density: Option<&str>) -> &'static str {
    match density {
        Some("mdpi") | Some("hdpi") => "skip-density-variant",
        Some(_) => "download-candidate",
        None => "review",
    }
}

fn layer_bounds(value: &serde_json::Value) -> Option<LakeBounds> {
    let object = value.as_object()?;
    let source = ["frame", "bounds", "rect", "geometry"]
        .iter()
        .find_map(|key| object.get(*key).and_then(serde_json::Value::as_object))
        .unwrap_or(object);
    let number = |keys: &[&str]| {
        keys.iter()
            .find_map(|key| {
                source
                    .get(*key)
                    .and_then(|item| item.as_f64().or_else(|| item.as_str()?.parse().ok()))
            })
            .filter(|item| item.is_finite())
    };
    Some(LakeBounds {
        x: number(&["x", "left"]).unwrap_or(0.0),
        y: number(&["y", "top"]).unwrap_or(0.0),
        width: number(&["width", "w"]).unwrap_or(0.0),
        height: number(&["height", "h"]).unwrap_or(0.0),
    })
}

fn collect_layers(
    value: &serde_json::Value,
    parent_id: Option<&str>,
    depth: usize,
    path: &str,
    output: &mut Vec<LakeLayerSummary>,
    assets: &mut Vec<LakeAssetSummary>,
) {
    if output.len() >= 5000 {
        return;
    }
    let Some(object) = value.as_object() else {
        return;
    };
    let id = json_string(value, &["id", "layer_id", "layerId", "node_id", "nodeId"])
        .unwrap_or_else(|| format!("lake-layer-{path}"));
    let has_layer_shape = object.keys().any(|key| {
        matches!(
            key.as_str(),
            "name"
                | "type"
                | "layerType"
                | "nodeType"
                | "frame"
                | "bounds"
                | "children"
                | "layers"
                | "text"
        )
    });
    let current_parent = if has_layer_shape {
        let raw_name = json_string(value, &["name", "title", "label"]);
        let name = raw_name.clone().unwrap_or_else(|| "未命名图层".to_string());
        let layer_type = json_string(value, &["type", "layerType", "nodeType", "kind", "tag"])
            .unwrap_or_else(|| "unknown".to_string());
        let text = json_string(value, &["text", "content", "characters"]).or_else(|| {
            let normalized_type = layer_type.to_ascii_lowercase();
            normalized_type
                .contains("text")
                .then_some(raw_name)
                .flatten()
        });
        let visible = object
            .get("visible")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(true)
            && object
                .get("hidden")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false)
                == false;
        let source_url = asset_url(value);
        if source_url.is_some()
            || layer_type.to_ascii_lowercase().contains("image")
            || layer_type.to_ascii_lowercase().contains("bitmap")
        {
            let bounds = layer_bounds(value);
            let asset_id = format!("lake-asset:{id}");
            if !assets.iter().any(|asset| asset.id == asset_id) {
                let density = asset_density(value, &name, source_url.as_deref());
                let download_policy = asset_download_policy(density.as_deref()).to_string();
                let download_status = match download_policy.as_str() {
                    "skip-density-variant" => "skipped",
                    "review" => "review",
                    _ => "pending",
                }
                .to_string();
                assets.push(LakeAssetSummary {
                    id: asset_id,
                    name: name.clone(),
                    kind: if layer_type.to_ascii_lowercase().contains("icon") {
                        "icon".to_string()
                    } else {
                        "image".to_string()
                    },
                    source_url: source_url.clone(),
                    width: bounds.as_ref().map(|item| item.width),
                    height: bounds.as_ref().map(|item| item.height),
                    density,
                    download_policy,
                    local_path: None,
                    download_status,
                    checksum: None,
                    byte_size: None,
                    mime_type: None,
                    reference_count: 1,
                });
            }
        }
        output.push(LakeLayerSummary {
            id: id.clone(),
            parent_id: parent_id.map(str::to_string),
            name,
            layer_type,
            bounds: layer_bounds(value),
            text,
            visible,
            depth,
            style: layer_style(value),
            asset_url: source_url,
        });
        Some(id.as_str())
    } else {
        parent_id
    };
    for key in ["layers", "children", "nodes", "items"] {
        if let Some(items) = object.get(key).and_then(serde_json::Value::as_array) {
            for (index, child) in items.iter().enumerate() {
                collect_layers(
                    child,
                    current_parent,
                    depth + 1,
                    &format!("{path}.{key}[{index}]"),
                    output,
                    assets,
                );
            }
        }
    }
    for key in ["artboard", "design", "document", "page"] {
        if let Some(child) = object.get(key) {
            collect_layers(
                child,
                current_parent,
                depth,
                &format!("{path}.{key}"),
                output,
                assets,
            );
        }
    }
}

fn extract_layers(value: &serde_json::Value) -> (Vec<LakeLayerSummary>, Vec<LakeAssetSummary>) {
    let mut layers = Vec::new();
    let mut assets = Vec::new();
    collect_layers(value, None, 0, "root", &mut layers, &mut assets);
    let mut references = HashMap::<String, usize>::new();
    for layer in &layers {
        if let Some(url) = layer.asset_url.as_ref() {
            *references.entry(url.clone()).or_default() += 1;
        }
    }
    let mut seen_urls = HashSet::new();
    assets.retain(|asset| {
        let Some(url) = asset.source_url.as_ref() else {
            return true;
        };
        seen_urls.insert(url.clone())
    });
    for asset in &mut assets {
        asset.reference_count = asset
            .source_url
            .as_ref()
            .and_then(|url| references.get(url))
            .copied()
            .unwrap_or(1);
    }
    (layers, assets)
}

#[tauri::command]
async fn get_lake_session(app: tauri::AppHandle) -> Result<LakeSession, String> {
    let Some(webview) = app.get_webview("lanhu-browser") else {
        return Err("Lake 浏览窗口尚未打开".to_string());
    };
    let (sender, receiver) = mpsc::channel();
    webview.eval_with_callback(
        r#"(() => ({ cookies: document.cookie || "", token: localStorage.getItem("token") || localStorage.getItem("access_token") || localStorage.getItem("accessToken") || "" }))()"#,
        move |payload| { let _ = sender.send(payload); },
    ).map_err(|error| format!("读取 Lake 当前会话失败：{error}"))?;
    let payload =
        tauri::async_runtime::spawn_blocking(move || receiver.recv_timeout(Duration::from_secs(3)))
            .await
            .map_err(|error| format!("读取 Lake 当前会话任务失败：{error}"))?
            .map_err(|_| "读取 Lake 当前会话超时".to_string())?;
    let value: serde_json::Value =
        serde_json::from_str(&payload).map_err(|_| "Lake 会话结果格式无效".to_string())?;
    let value = if let serde_json::Value::String(serialized) = value {
        serde_json::from_str(&serialized).map_err(|_| "Lake 会话结果格式无效".to_string())?
    } else {
        value
    };
    serde_json::from_value(value).map_err(|_| "Lake 会话结果格式无效".to_string())
}

#[derive(Debug, Deserialize, Serialize)]
struct CachedAsset {
    checksum: String,
    local_path: String,
    byte_size: usize,
    mime_type: Option<String>,
}

fn asset_cache_file(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("获取资源缓存目录失败：{error}"))?;
    fs::create_dir_all(&directory).map_err(|error| format!("创建资源缓存目录失败：{error}"))?;
    Ok(directory.join("asset-cache.json"))
}

fn load_asset_cache(app: &tauri::AppHandle) -> Result<HashMap<String, CachedAsset>, String> {
    let path = asset_cache_file(app)?;
    match fs::read_to_string(path) {
        Ok(value) => {
            serde_json::from_str(&value).map_err(|error| format!("解析资源缓存失败：{error}"))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(HashMap::new()),
        Err(error) => Err(format!("读取资源缓存失败：{error}")),
    }
}

fn save_asset_cache(
    app: &tauri::AppHandle,
    cache: &HashMap<String, CachedAsset>,
) -> Result<(), String> {
    let path = asset_cache_file(app)?;
    let temporary = path.with_extension("json.tmp");
    let content =
        serde_json::to_vec_pretty(cache).map_err(|error| format!("序列化资源缓存失败：{error}"))?;
    fs::write(&temporary, content).map_err(|error| format!("写入资源缓存失败：{error}"))?;
    fs::rename(temporary, path).map_err(|error| format!("提交资源缓存失败：{error}"))
}

fn safe_asset_filename(asset: &LakeAssetSummary, index: usize, source_url: &str) -> String {
    let source_name = Url::parse(source_url)
        .ok()
        .and_then(|url| {
            url.path_segments()
                .and_then(|mut segments| segments.next_back())
                .map(str::to_string)
        })
        .filter(|name| !name.trim().is_empty())
        .unwrap_or_else(|| "asset.bin".to_string());
    let preferred = if asset.name.trim().is_empty() {
        source_name
    } else {
        asset.name.clone()
    };
    let sanitized: String = preferred
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '_') {
                character
            } else {
                '_'
            }
        })
        .collect();
    let sanitized = if sanitized.trim_matches('.').is_empty() {
        "asset.bin".to_string()
    } else {
        sanitized
    };
    format!("{index:04}-{}", sanitized.trim_matches('.'))
}

fn response_mime_type(response: &reqwest::Response) -> Option<String> {
    response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(|value| {
            value
                .split(';')
                .next()
                .unwrap_or(value)
                .trim()
                .to_ascii_lowercase()
        })
        .filter(|value| !value.is_empty())
}

fn asset_checksum(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

async fn download_candidate_assets(
    app: &tauri::AppHandle,
    client: &reqwest::Client,
    session: &LakeSession,
    route: &LakeRoute,
    assets: &mut [LakeAssetSummary],
) -> Result<(usize, usize, usize, Vec<String>), String> {
    let mut directory = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("获取资源目录失败：{error}"))?;
    let document_key = format!(
        "{}-{}",
        route.project_id.as_deref().unwrap_or("project"),
        route.image_id.as_deref().unwrap_or("image")
    );
    let safe_document_key: String = document_key
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_') {
                character
            } else {
                '_'
            }
        })
        .collect();
    directory.push("documents");
    directory.push(safe_document_key);
    directory.push("assets");
    fs::create_dir_all(&directory).map_err(|error| format!("创建资源目录失败：{error}"))?;

    let mut notes = Vec::new();
    let mut cache = match load_asset_cache(app) {
        Ok(cache) => cache,
        Err(error) => {
            notes.push(format!("读取资源缓存失败，本次将重新下载资源：{error}"));
            HashMap::new()
        }
    };
    let mut downloaded = 0;
    let mut cached = 0;
    let mut skipped = 0;
    for (index, asset) in assets.iter_mut().enumerate() {
        if asset.download_policy != "download-candidate" {
            skipped += 1;
            continue;
        }
        let Some(source_url) = asset.source_url.clone() else {
            asset.download_status = "failed".to_string();
            notes.push(format!("资源 {} 缺少 URL，未下载。", asset.name));
            continue;
        };
        if let Some(entry) = cache.get(&source_url) {
            let path = PathBuf::from(&entry.local_path);
            if path.is_file() {
                match fs::read(&path) {
                    Ok(bytes)
                        if bytes.len() == entry.byte_size
                            && asset_checksum(&bytes) == entry.checksum =>
                    {
                        asset.local_path = Some(entry.local_path.clone());
                        asset.checksum = Some(entry.checksum.clone());
                        asset.byte_size = Some(entry.byte_size);
                        asset.mime_type = entry.mime_type.clone();
                        asset.download_status = "cached".to_string();
                        cached += 1;
                        continue;
                    }
                    Ok(_) => notes.push(format!(
                        "资源 {} 的本地缓存校验失败，将重新下载。",
                        asset.name
                    )),
                    Err(error) => notes.push(format!(
                        "资源 {} 的本地缓存无法读取，将重新下载：{error}",
                        asset.name
                    )),
                }
                cache.remove(&source_url);
            }
        }
        let parsed_url = match Url::parse(&source_url) {
            Ok(url) if matches!(url.scheme(), "http" | "https") => url,
            _ => {
                asset.download_status = "failed".to_string();
                notes.push(format!("资源 {} 的 URL 不是 HTTP(S)，未下载。", asset.name));
                continue;
            }
        };
        let filename = safe_asset_filename(asset, index, parsed_url.as_str());
        let destination = directory.join(filename);
        let mut request = client.get(parsed_url);
        if let Some(cookies) = session
            .cookies
            .as_deref()
            .filter(|value| !value.trim().is_empty())
        {
            request = request.header(reqwest::header::COOKIE, cookies);
        }
        if let Some(token) = session
            .token
            .as_deref()
            .filter(|value| !value.trim().is_empty())
        {
            request = request.header("token", token);
        }
        let response = match request.send().await {
            Ok(response) => response,
            Err(error) => {
                asset.download_status = "failed".to_string();
                notes.push(format!("资源 {} 下载请求失败：{error}", asset.name));
                continue;
            }
        };
        let status = response.status();
        if !status.is_success() {
            asset.download_status = "failed".to_string();
            notes.push(format!(
                "资源 {} 下载失败：HTTP {}。",
                asset.name,
                status.as_u16()
            ));
            continue;
        }
        let mime_type = response_mime_type(&response);
        if matches!(asset.kind.as_str(), "image" | "icon")
            && mime_type
                .as_deref()
                .is_some_and(|value| !value.starts_with("image/"))
        {
            asset.download_status = "failed".to_string();
            notes.push(format!(
                "资源 {} 的响应类型 {} 不是图片，未保存。",
                asset.name,
                mime_type.as_deref().unwrap_or("unknown")
            ));
            continue;
        }
        if response
            .content_length()
            .is_some_and(|length| length > 25 * 1024 * 1024)
        {
            asset.download_status = "failed".to_string();
            notes.push(format!("资源 {} 超过 25 MB 限制，未下载。", asset.name));
            continue;
        }
        let bytes = match response.bytes().await {
            Ok(bytes) if bytes.len() <= 25 * 1024 * 1024 => bytes,
            Ok(_) => {
                asset.download_status = "failed".to_string();
                notes.push(format!("资源 {} 超过 25 MB 限制，未下载。", asset.name));
                continue;
            }
            Err(error) => {
                asset.download_status = "failed".to_string();
                notes.push(format!("资源 {} 读取失败：{error}", asset.name));
                continue;
            }
        };
        let checksum = asset_checksum(&bytes);
        let temporary = destination.with_extension("download");
        if let Err(error) =
            fs::write(&temporary, &bytes).and_then(|_| fs::rename(&temporary, &destination))
        {
            let _ = fs::remove_file(&temporary);
            asset.download_status = "failed".to_string();
            notes.push(format!("资源 {} 写入本地失败：{error}", asset.name));
            continue;
        }
        let local_path = destination.to_string_lossy().into_owned();
        asset.local_path = Some(local_path.clone());
        asset.checksum = Some(checksum.clone());
        asset.byte_size = Some(bytes.len());
        asset.mime_type = mime_type.clone();
        asset.download_status = "downloaded".to_string();
        cache.insert(
            source_url,
            CachedAsset {
                checksum,
                local_path,
                byte_size: bytes.len(),
                mime_type,
            },
        );
        downloaded += 1;
    }
    if let Err(error) = save_asset_cache(app, &cache) {
        notes.push(format!("保存资源缓存失败，下次同步可能重新下载：{error}"));
    }
    Ok((downloaded, cached, skipped, notes))
}

#[tauri::command]
async fn fetch_lake_design_data(
    app: tauri::AppHandle,
    page_url: String,
    session: LakeSession,
) -> Result<LakeApiSyncResult, String> {
    let route = lake_route(&page_url).map_err(|error| error.to_string())?;
    let endpoint = lake_api_url(&route)?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        // The design API is protected by the same edge rules as the web app.
        // Keep the native request shaped like the authenticated page request
        // instead of looking like a bare Rust client.
        .user_agent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15")
        .build()
        .map_err(|error| format!("创建 API 客户端失败：{error}"))?;
    let mut request = client
        .get(endpoint.clone())
        .header(reqwest::header::ACCEPT, "application/json, text/plain, */*")
        .header(reqwest::header::ACCEPT_LANGUAGE, "zh-CN,zh;q=0.9,en;q=0.8")
        .header(reqwest::header::REFERER, &page_url)
        .header(reqwest::header::ORIGIN, "https://lanhuapp.com")
        .header("X-Requested-With", "XMLHttpRequest");
    if let Some(cookies) = session
        .cookies
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        request = request.header(reqwest::header::COOKIE, cookies);
    }
    if let Some(token) = session
        .token
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        request = request.header("token", token);
    }
    let mut response = None;
    for attempt in 0..3 {
        let current = request
            .try_clone()
            .ok_or_else(|| "API 请求无法重试".to_string())?
            .send()
            .await
            .map_err(|error| format!("api-requested 阶段失败：{error}"))?;
        if current.status().as_u16() == 418 && attempt < 2 {
            tokio::time::sleep(Duration::from_millis(700 * (attempt + 1))).await;
            continue;
        }
        response = Some(current);
        break;
    }
    let response = response.ok_or_else(|| "api-requested 阶段失败".to_string())?;
    let http_status = response.status().as_u16();
    let body = response
        .text()
        .await
        .map_err(|error| format!("api-response-received 阶段失败：{error}"))?;
    if http_status == 401 || http_status == 403 {
        return Err("credentials-read 阶段失败：当前登录态无权访问此设计稿".to_string());
    }
    if !(200..300).contains(&http_status) {
        return Err(format!(
            "api-response-received 阶段失败：HTTP {http_status}"
        ));
    }
    let value: serde_json::Value = serde_json::from_str(&body)
        .map_err(|_| "api-response-received 阶段失败：响应不是 JSON".to_string())?;
    if let Some(code) = value.get("code") {
        let ok = code.as_i64() == Some(0)
            || code
                .as_str()
                .map(|v| v == "0" || v == "00000")
                .unwrap_or(false);
        if !ok {
            return Err("api-response-received 阶段失败：Lake API 未授权当前请求".to_string());
        }
    }
    let data = response_data(&value);
    let raw_json_url = json_url(data)
        .ok_or_else(|| "json-url-found 阶段失败：API 响应中没有 json_url".to_string())?;
    let json_endpoint = normalize_json_url(&raw_json_url)?;
    let mut json_request = client.get(json_endpoint.clone());
    if let Some(cookies) = session
        .cookies
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        json_request = json_request.header(reqwest::header::COOKIE, cookies);
    }
    let json_response = json_request
        .send()
        .await
        .map_err(|error| format!("json-downloaded 阶段失败：{error}"))?;
    let json_status = json_response.status().as_u16();
    if !(200..300).contains(&json_status) {
        return Err(format!("json-downloaded 阶段失败：HTTP {json_status}"));
    }
    let json_body = json_response
        .bytes()
        .await
        .map_err(|error| format!("json-downloaded 阶段失败：{error}"))?;
    let design: serde_json::Value = serde_json::from_slice(&json_body)
        .map_err(|_| "json-downloaded 阶段失败：下载内容不是 JSON".to_string())?;
    let root_keys = design
        .as_object()
        .map(|object| object.keys().take(40).cloned().collect())
        .unwrap_or_default();
    let (layers, mut assets) = extract_layers(&design);
    let mut notes = vec!["API/设计 JSON 已确认，页面 DOM 仅作为诊断信息。".to_string()];
    notes.push(format!("已从设计 JSON 提取 {} 个图层摘要。", layers.len()));
    let skipped = assets
        .iter()
        .filter(|asset| asset.download_policy == "skip-density-variant")
        .count();
    let candidates = assets
        .iter()
        .filter(|asset| asset.download_policy == "download-candidate")
        .count();
    let review = assets
        .iter()
        .filter(|asset| asset.download_policy == "review")
        .count();
    notes.push(format!(
        "已发现 {} 个资源引用候选：{} 个可下载候选，{} 个 mdpi/hdpi 跳过，{} 个待确认。",
        assets.len(),
        candidates,
        skipped,
        review
    ));
    let (downloaded, cached, policy_skipped, download_notes) =
        download_candidate_assets(&app, &client, &session, &route, &mut assets).await?;
    notes.push(format!("资源下载完成：新下载 {} 个，缓存复用 {} 个，按策略跳过 {} 个；下载失败或待确认资源不会阻断本次同步。", downloaded, cached, policy_skipped));
    notes.extend(download_notes);
    if layers.len() >= 5000 {
        notes.push("图层摘要达到 5000 条保护上限，后续需要按画板分页解析。".to_string());
    }
    Ok(LakeApiSyncResult {
        status: "ready".to_string(),
        stage: "json-downloaded".to_string(),
        endpoint: Some(endpoint.to_string()),
        http_status: Some(http_status),
        project_id: route.project_id,
        image_id: route.image_id,
        team_id: route.team_id,
        json_url: Some(json_endpoint.to_string()),
        json_size: Some(json_body.len()),
        root_keys,
        layers,
        assets,
        notes,
    })
}

fn state_file(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    fs::create_dir_all(&directory).map_err(|error| format!("创建应用数据目录失败：{error}"))?;
    Ok(directory.join("state.json"))
}

#[tauri::command]
fn load_app_state(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let path = state_file(&app)?;
    match fs::read_to_string(path) {
        Ok(value) => Ok(Some(value)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("读取应用数据失败：{error}")),
    }
}

#[tauri::command]
fn save_app_state(app: tauri::AppHandle, state: String) -> Result<(), String> {
    let path = state_file(&app)?;
    let temporary = path.with_extension("json.tmp");
    fs::write(&temporary, state).map_err(|error| format!("写入应用数据失败：{error}"))?;
    fs::rename(temporary, path).map_err(|error| format!("提交应用数据失败：{error}"))
}

#[derive(Debug, Serialize)]
struct McpConnectionInfo {
    project_root: String,
    codex_config_path: String,
    command: String,
    args: Vec<String>,
}

fn pnpm_command() -> String {
    ["/opt/homebrew/bin/pnpm", "/usr/local/bin/pnpm"]
        .iter()
        .map(PathBuf::from)
        .find(|path| path.is_file())
        .map(|path| path.display().to_string())
        .unwrap_or_else(|| "pnpm".to_string())
}

fn mcp_connection_info(app: &tauri::AppHandle) -> Result<McpConnectionInfo, String> {
    let home = env::var_os("HOME").ok_or_else(|| "无法确定当前用户的 HOME 目录".to_string())?;
    let config_path = PathBuf::from(home).join(".codex").join("config.toml");
    let bundled_server = app
        .path()
        .resource_dir()
        .ok()
        .map(|path| path.join("mcp-server"));
    if let Some(server_dir) = bundled_server {
        let bundled_node = server_dir.join("node");
        let bundled_entry = server_dir.join("index.mjs");
        if bundled_node.is_file() && bundled_entry.is_file() {
            return Ok(McpConnectionInfo {
                project_root: server_dir.display().to_string(),
                codex_config_path: config_path.display().to_string(),
                command: bundled_node.display().to_string(),
                args: vec![bundled_entry.display().to_string()],
            });
        }
    }

    // Development fallback: use the workspace source when the app resources
    // have not been prepared by the production bundle step yet.
    let project_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("..");
    let project_root = project_root
        .canonicalize()
        .map_err(|error| format!("找不到 Lake MCP 项目目录：{error}"))?;
    let mcp_entry = project_root
        .join("packages")
        .join("mcp-server")
        .join("src")
        .join("index.ts");
    if !mcp_entry.is_file() {
        return Err(format!(
            "当前安装中没有找到 MCP Server：{}",
            mcp_entry.display()
        ));
    }
    let pnpm = pnpm_command();
    let args = vec![
        "-lc".to_string(),
        format!(
            "cd {} && exec {} --filter @lake/mcp-server start",
            project_root.display(),
            pnpm
        ),
    ];
    Ok(McpConnectionInfo {
        project_root: project_root.display().to_string(),
        codex_config_path: config_path.display().to_string(),
        command: "/bin/zsh".to_string(),
        args,
    })
}

fn codex_mcp_block(info: &McpConnectionInfo) -> String {
    let quote = |value: &str| format!(
        "\"{}\"",
        value.replace('\\', "\\\\").replace('"', "\\\"")
    );
    let args = info.args.iter().map(|arg| quote(arg)).collect::<Vec<_>>().join(", ");
    format!(
        "[mcp_servers.lake]\ncommand = {}\nargs = [{}]\n",
        quote(&info.command), args
    )
}

fn upsert_codex_mcp_config(config: &str, block: &str) -> String {
    let mut lines = config.lines().collect::<Vec<_>>();
    if let Some(start) = lines
        .iter()
        .position(|line| line.trim() == "[mcp_servers.lake]")
    {
        let end = lines
            .iter()
            .enumerate()
            .skip(start + 1)
            .find(|(_, line)| line.trim_start().starts_with('['))
            .map(|(index, _)| index)
            .unwrap_or(lines.len());
        let replacement = block.trim_end().lines().collect::<Vec<_>>();
        lines.splice(start..end, replacement);
        format!("{}\n", lines.join("\n")).replace("\n\n\n", "\n\n")
    } else {
        let trimmed = config.trim_end();
        if trimmed.is_empty() {
            format!("{}\n", block.trim_end())
        } else {
            format!("{}\n\n{}\n", trimmed, block.trim_end())
        }
    }
}

#[tauri::command]
fn configure_codex_mcp(app: tauri::AppHandle) -> Result<String, String> {
    let info = mcp_connection_info(&app)?;
    let config_path = PathBuf::from(&info.codex_config_path);

    let config_dir = config_path
        .parent()
        .ok_or_else(|| "Codex 配置目录无效".to_string())?;
    fs::create_dir_all(config_dir).map_err(|error| format!("创建 Codex 配置目录失败：{error}"))?;
    let existing = match fs::read_to_string(&config_path) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(error) => return Err(format!("读取 Codex 配置失败：{error}")),
    };
    if !existing.is_empty() {
        fs::write(config_path.with_extension("toml.bak"), &existing)
            .map_err(|error| format!("备份 Codex 配置失败：{error}"))?;
    }
    let updated = upsert_codex_mcp_config(&existing, &codex_mcp_block(&info));
    fs::write(&config_path, updated).map_err(|error| format!("写入 Codex 配置失败：{error}"))?;
    Ok(config_path.display().to_string())
}

#[tauri::command]
fn get_mcp_connection_info(app: tauri::AppHandle) -> Result<McpConnectionInfo, String> {
    mcp_connection_info(&app)
}

#[tauri::command]
fn copy_text_to_clipboard(text: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let mut child = Command::new("/usr/bin/pbcopy")
            .arg("-Prefer")
            .arg("txt")
            .env("LC_CTYPE", "UTF-8")
            .stdin(Stdio::piped())
            .spawn()
            .map_err(|error| format!("启动系统剪贴板失败：{error}"))?;
        child
            .stdin
            .take()
            .ok_or_else(|| "无法打开系统剪贴板输入流".to_string())?
            .write_all(text.as_bytes())
            .map_err(|error| format!("写入系统剪贴板失败：{error}"))?;
        let result = child
            .wait()
            .map_err(|error| format!("等待系统剪贴板完成失败：{error}"))?;
        if !result.success() {
            return Err(format!("系统剪贴板返回状态：{result}"));
        }

        let pasted = Command::new("/usr/bin/pbpaste")
            .arg("-Prefer")
            .arg("txt")
            .env("LC_CTYPE", "UTF-8")
            .output()
            .map_err(|error| format!("校验系统剪贴板失败：{error}"))?;
        if !pasted.status.success() || pasted.stdout != text.as_bytes() {
            return Err("系统剪贴板没有确认收到完整内容".to_string());
        }
        return Ok(());
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = text;
        Err("当前平台暂不支持应用内复制".to_string())
    }
}

#[derive(Debug, Serialize)]
struct AssetCleanupResult {
    stale_cache_entries: usize,
    orphan_files: usize,
    removed_files: usize,
    notes: Vec<String>,
}

#[tauri::command]
fn cleanup_asset_cache(
    app: tauri::AppHandle,
    referenced_paths: Vec<String>,
    delete_orphans: bool,
) -> Result<AssetCleanupResult, String> {
    let mut notes = Vec::new();
    let mut stale_cache_entries = 0;
    let mut cache = match load_asset_cache(&app) {
        Ok(cache) => cache,
        Err(error) => {
            notes.push(format!("读取资源缓存索引失败：{error}"));
            HashMap::new()
        }
    };
    let stale_urls: Vec<String> = cache
        .iter()
        .filter(|(_, entry)| !PathBuf::from(&entry.local_path).is_file())
        .map(|(url, _)| url.clone())
        .collect();
    for url in stale_urls {
        cache.remove(&url);
        stale_cache_entries += 1;
    }
    if stale_cache_entries > 0 {
        if let Err(error) = save_asset_cache(&app, &cache) {
            notes.push(format!("保存清理后的资源缓存索引失败：{error}"));
        }
    }

    let referenced: HashSet<PathBuf> = referenced_paths.into_iter().map(PathBuf::from).collect();
    let documents_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("获取资源目录失败：{error}"))?
        .join("documents");
    let mut orphan_files = 0;
    let mut removed_files = 0;
    if let Ok(document_entries) = fs::read_dir(&documents_dir) {
        for document_entry in document_entries.flatten() {
            let assets_dir = document_entry.path().join("assets");
            let Ok(asset_entries) = fs::read_dir(assets_dir) else {
                continue;
            };
            for asset_entry in asset_entries.flatten() {
                let path = asset_entry.path();
                if !asset_entry
                    .file_type()
                    .map(|kind| kind.is_file())
                    .unwrap_or(false)
                    || referenced.contains(&path)
                {
                    continue;
                }
                orphan_files += 1;
                if delete_orphans {
                    match fs::remove_file(&path) {
                        Ok(()) => removed_files += 1,
                        Err(error) => {
                            notes.push(format!("删除孤立资源 {} 失败：{error}", path.display()))
                        }
                    }
                }
            }
        }
    }
    if !delete_orphans && orphan_files > 0 {
        notes.push("发现未被当前文档引用的资源文件，确认后才会删除。".to_string());
    }
    Ok(AssetCleanupResult {
        stale_cache_entries,
        orphan_files,
        removed_files,
        notes,
    })
}

#[tauri::command]
async fn get_lanhu_browser_url(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let Some(webview) = app.get_webview("lanhu-browser") else {
        return Ok(None);
    };

    // Lake is a single-page application. Its design switcher can update the
    // hash/history without a native WebView navigation, so WebviewWindow::url
    // may remain stale. Read the URL from the page itself instead.
    let (sender, receiver) = mpsc::channel();
    webview
        .eval_with_callback("window.location.href", move |value| {
            let _ = sender.send(value);
        })
        .map_err(|error| error.to_string())?;
    let payload = tauri::async_runtime::spawn_blocking(move || {
        receiver.recv_timeout(Duration::from_secs(2))
    })
    .await
    .map_err(|error| format!("读取 Lake 页面地址任务失败：{error}"))?
    .map_err(|error| format!("读取 Lake 页面地址超时：{error}"))?;
    let value: serde_json::Value = serde_json::from_str(&payload)
        .or_else(|_| serde_json::from_str(&serde_json::from_str::<String>(&payload).unwrap_or_default()))
        .map_err(|error| format!("解析 Lake 页面地址失败：{error}"))?;
    Ok(value.as_str().map(str::to_string))
}

fn validate_lake_url(raw: &str) -> Result<Url, String> {
    let parsed = Url::parse(raw).map_err(|_| "Lake 页面地址不是有效 URL".to_string())?;
    let host = parsed.host_str().unwrap_or_default();
    if parsed.scheme() != "https"
        || !(host == "lanhuapp.com" || host.ends_with(".lanhuapp.com"))
    {
        return Err("只能导航到 Lake 页面地址".to_string());
    }
    Ok(parsed)
}

#[tauri::command]
fn open_lanhu_browser(
    app: tauri::AppHandle,
    url: String,
) -> Result<(), String> {
    let parsed = validate_lake_url(&url)?;

    if let Some(webview) = app.get_webview("lanhu-browser") {
        webview
            .navigate(parsed)
            .and_then(|_| webview.show())
            .and_then(|_| webview.set_focus())
            .map_err(|error| format!("显示 Lake 页面失败：{error}"))?;
        return Ok(());
    }

    WebviewWindowBuilder::new(&app, "lanhu-browser", WebviewUrl::External(parsed))
        .title("Lake")
        .inner_size(1280.0, 860.0)
        .min_inner_size(900.0, 600.0)
        .incognito(false)
        .data_store_identifier(LAKE_DATA_STORE_IDENTIFIER)
        .build()
        .map_err(|error| format!("创建 Lake 页面窗口失败：{error}"))?;
    Ok(())
}

#[tauri::command]
fn focus_lanhu_browser(app: tauri::AppHandle) -> Result<bool, String> {
    let Some(webview) = app.get_webview("lanhu-browser") else {
        return Ok(false);
    };
    webview
        .show()
        .map_err(|error| format!("显示 Lake 页面窗口失败：{error}"))?;
    webview
        .set_focus()
        .map_err(|error| format!("聚焦 Lake 页面窗口失败：{error}"))?;
    Ok(true)
}

#[tauri::command]
fn navigate_lanhu_browser(app: tauri::AppHandle, url: String) -> Result<(), String> {
    let parsed = validate_lake_url(&url)?;
    let Some(webview) = app.get_webview("lanhu-browser") else {
        return Err("Lake 页面窗口尚未打开".to_string());
    };
    webview
        .navigate(parsed)
        .map_err(|error| format!("导航到 Lake 页面失败：{error}"))
}

#[tauri::command]
fn clear_lanhu_session(app: tauri::AppHandle) -> Result<(), String> {
    let Some(webview) = app.get_webview("lanhu-browser") else {
        return Ok(());
    };
    // Clear origin-local state immediately as well. This covers auth flows
    // that keep a token in Web Storage while the native WebKit store is being
    // cleared asynchronously.
    webview
        .eval("try { localStorage.clear(); sessionStorage.clear(); } catch (_) {}")
        .map_err(|error| format!("清除 Lake 页面存储失败：{error}"))?;
    webview
        .clear_all_browsing_data()
        .map_err(|error| format!("清除 Lake 登录状态失败：{error}"))?;
    webview
        .close()
        .map_err(|error| format!("关闭 Lake 页面窗口失败：{error}"))
}

#[derive(Debug, Deserialize, Serialize)]
struct LanhuBrowserSnapshot {
    url: String,
    title: String,
    ready_state: String,
    dom_element_count: usize,
    node_marker_count: usize,
    semantic_element_count: usize,
    content_editable_count: usize,
    body_text_length: usize,
    image_count: usize,
    canvas_count: usize,
    svg_count: usize,
    iframe_count: usize,
    shadow_root_count: usize,
    svg_summaries: Vec<LanhuSvgSummary>,
    visible_surface_summaries: Vec<LanhuSurfaceSummary>,
    image_summaries: Vec<LanhuImageSummary>,
    annotation_summaries: Vec<LanhuAnnotationSummary>,
    platform_context: Option<LanhuPlatformContext>,
    node_candidates: Vec<LanhuNodeCandidate>,
    node_candidate_limit_reached: bool,
}

#[derive(Debug, Deserialize, Serialize)]
struct LanhuPlatformContext {
    label: Option<String>,
    kind: String,
    design_unit: String,
    viewport_width: Option<f64>,
    content_height: Option<f64>,
    scrollable: bool,
    confidence: String,
    source: String,
}

#[derive(Debug, Deserialize, Serialize)]
struct LanhuSvgSummary {
    id: Option<String>,
    class_name: Option<String>,
    width: f64,
    height: f64,
    view_box: Option<String>,
    element_count: usize,
    visible: bool,
}

#[derive(Debug, Deserialize, Serialize)]
struct LanhuSurfaceSummary {
    tag_name: String,
    id: Option<String>,
    class_name: Option<String>,
    role: Option<String>,
    width: f64,
    height: f64,
    child_element_count: usize,
    image_descendant_count: usize,
    canvas_descendant_count: usize,
    svg_descendant_count: usize,
    background_image: bool,
}

#[derive(Debug, Deserialize, Serialize)]
struct LanhuImageSummary {
    id: Option<String>,
    class_name: Option<String>,
    width: f64,
    height: f64,
    natural_width: u32,
    natural_height: u32,
    visible: bool,
}

#[derive(Debug, Deserialize, Serialize)]
struct LanhuAnnotationSummary {
    tag_name: String,
    id: Option<String>,
    class_name: Option<String>,
    role: Option<String>,
    width: f64,
    height: f64,
    text_length: usize,
    numeric_values: Vec<f64>,
    measurements: Vec<LanhuAnnotationMeasurement>,
    likely_measurements: Vec<f64>,
    px_value_count: usize,
    child_element_count: usize,
    visible: bool,
}

#[derive(Debug, Deserialize, Serialize)]
struct LanhuAnnotationMeasurement {
    value: f64,
    unit: String,
}

#[derive(Debug, Deserialize, Serialize)]
struct LanhuNodeCandidate {
    marker: String,
    marker_type: String,
    tag_name: String,
    class_name: Option<String>,
    role: Option<String>,
    svg_ancestor: bool,
    ancestor_depth: usize,
    classification: String,
    name: Option<String>,
    parent_marker: Option<String>,
    bounds: Option<LanhuNodeBounds>,
    visible: bool,
}

#[derive(Debug, Deserialize, Serialize)]
struct LanhuNodeBounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

#[derive(Debug, Deserialize, Serialize)]
struct LanhuStructuredDataProbe {
    status: String,
    resource_count: usize,
    json_resource_count: usize,
    parsed_resource_count: usize,
    node_count: usize,
    asset_count: usize,
    measurement_count: usize,
    resources: Vec<LanhuStructuredResource>,
    nodes: Vec<LanhuStructuredNode>,
    assets: Vec<LanhuStructuredAsset>,
    notes: Vec<String>,
}

#[derive(Debug, Deserialize, Serialize)]
struct LanhuStructuredResource {
    path: String,
    status: u16,
    content_type: Option<String>,
    parsed: bool,
    top_level_keys: Vec<String>,
}

#[derive(Debug, Deserialize, Serialize)]
struct LanhuStructuredNode {
    source_path: String,
    node_type: Option<String>,
    name: Option<String>,
    text: Option<String>,
    bounds: Option<LanhuNodeBounds>,
    style_keys: Vec<String>,
    confidence: String,
}

#[derive(Debug, Deserialize, Serialize)]
struct LanhuStructuredAsset {
    source_path: String,
    name: Option<String>,
    kind: String,
    width: Option<f64>,
    height: Option<f64>,
    confidence: String,
}

#[tauri::command]
async fn get_lanhu_structured_data_probe(
    app: tauri::AppHandle,
) -> Result<Option<LanhuStructuredDataProbe>, String> {
    let Some(webview) = app.get_webview("lanhu-browser") else {
        return Ok(None);
    };

    let probe_key = format!(
        "__lanhuStructuredProbe_{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or_default()
    );
    webview
        .eval_with_callback(
            r#"(() => {
              const probeKey = '__PROBE_KEY__';
              window[probeKey] = { pending: true };
              (async () => {
              const currentOrigin = window.location.origin;
              const resourceEntries = performance.getEntriesByType('resource')
                .map((entry) => entry.name)
                .filter((value) => value.startsWith(currentOrigin));
              const uniqueResources = [...new Set(resourceEntries)];
              const candidates = uniqueResources.filter((value) => {
                const lower = value.toLowerCase();
                if (/\.(png|jpe?g|gif|webp|svg|woff2?|ttf)(\?|$)/i.test(lower)) return false;
                return /(api|schema|dds|sketch|json|project|image|detail|store|resource|layer|node)/i.test(lower);
              }).slice(-60);

              const numberValue = (value) => typeof value === 'number' && Number.isFinite(value) ? value : null;
              const textValue = (value) => typeof value === 'string' && value.trim().length > 0 ? value.trim().slice(0, 300) : null;
              const finiteBounds = (value) => {
                if (!value || typeof value !== 'object') return null;
                const source = value.bounds || value.frame || value.rect || value;
                const x = numberValue(source?.x ?? source?.left);
                const y = numberValue(source?.y ?? source?.top);
                const width = numberValue(source?.width ?? source?.w);
                const height = numberValue(source?.height ?? source?.h);
                return [x, y, width, height].every((item) => item !== null)
                  ? { x, y, width, height } : null;
              };
              const sourceUrlPath = (value) => {
                try { const url = new URL(value, currentOrigin); return `${url.pathname}${url.hash ? url.hash : ''}`; }
                catch { return String(value).split('?')[0].slice(0, 500); }
              };
              const nodes = [];
              const assets = [];
              const measurements = [];
              const seenObjects = new Set();
              const walk = (value, path, depth) => {
                if (!value || typeof value !== 'object' || depth > 18 || nodes.length >= 800) return;
                if (seenObjects.has(value)) return;
                seenObjects.add(value);
                if (Array.isArray(value)) {
                  value.slice(0, 500).forEach((item, index) => walk(item, `${path}[${index}]`, depth + 1));
                  return;
                }
                const keys = Object.keys(value);
                const bounds = finiteBounds(value);
                const name = textValue(value.name ?? value.title ?? value.label ?? value.id);
                const text = textValue(value.text ?? value.content ?? value.characters ?? value.value);
                const type = textValue(value.type ?? value.nodeType ?? value.kind ?? value.tag);
                const style = value.style && typeof value.style === 'object' ? Object.keys(value.style).slice(0, 32) : [];
                const hasNodeShape = Boolean(bounds) && Boolean(name || text || type || value.children || value.layers || value.type || value.nodeType);
                if (hasNodeShape) {
                  nodes.push({
                    source_path: path,
                    node_type: type,
                    name,
                    text,
                    bounds,
                    style_keys: style,
                    confidence: 'candidate'
                  });
                }
                const imageSource = value.src ?? value.url ?? value.imageUrl ?? value.image_url ?? value.assetUrl;
                if (typeof imageSource === 'string' && /\.(png|jpe?g|gif|webp|svg)(\?|$)/i.test(imageSource)) {
                  assets.push({
                    source_path: path,
                    name,
                    kind: /svg/i.test(imageSource) ? 'icon' : 'image',
                    width: numberValue(value.width),
                    height: numberValue(value.height),
                    confidence: 'candidate'
                  });
                }
                for (const key of keys) {
                  if (/width|height|x|y|fontSize|lineHeight|margin|padding|radius|opacity|spacing/i.test(key) && numberValue(value[key]) !== null) measurements.push(Number(value[key]));
                  walk(value[key], `${path}.${key}`, depth + 1);
                }
              };

              const resources = [];
              let parsedResourceCount = 0;
              for (const resource of candidates) {
                let response;
                try { response = await fetch(resource, { credentials: 'include' }); }
                catch { continue; }
                const contentType = response.headers.get('content-type') || undefined;
                const path = sourceUrlPath(resource);
                const item = { path, status: response.status, content_type: contentType, parsed: false, top_level_keys: [] };
                if (response.ok && (contentType || '').toLowerCase().includes('json')) {
                  try {
                    const text = await response.text();
                    if (text.length <= 2000000) {
                      const data = JSON.parse(text);
                      item.parsed = true;
                      parsedResourceCount += 1;
                      item.top_level_keys = data && typeof data === 'object' && !Array.isArray(data) ? Object.keys(data).slice(0, 60) : [];
                      walk(data, path, 0);
                    }
                  } catch { /* candidate was not readable JSON */ }
                }
                resources.push(item);
              }
              const uniqueNodes = [...new Map(nodes.map((node) => [`${node.source_path}:${node.name || ''}:${node.bounds?.x}:${node.bounds?.y}`, node])).values()].slice(0, 800);
              const uniqueAssets = [...new Map(assets.map((asset) => [`${asset.source_path}:${asset.name || ''}`, asset])).values()].slice(0, 300);
              const uniqueMeasurements = [...new Set(measurements.filter((value) => Number.isFinite(value) && value >= 0 && value <= 10000))].slice(0, 500);
              const jsonResourceCount = resources.filter((item) => (item.content_type || '').toLowerCase().includes('json')).length;
              const status = uniqueNodes.length || uniqueAssets.length ? 'partial' : resources.length ? 'candidate' : 'failed';
              return {
                status,
                resource_count: uniqueResources.length,
                json_resource_count: jsonResourceCount,
                parsed_resource_count: parsedResourceCount,
                node_count: uniqueNodes.length,
                asset_count: uniqueAssets.length,
                measurement_count: uniqueMeasurements.length,
                resources: resources.slice(0, 60),
                nodes: uniqueNodes,
                assets: uniqueAssets,
                notes: status === 'failed'
                  ? ['未发现可读取的同源结构化设计资源；当前页面可能通过跨域请求、运行时状态或其他接口提供数据。']
                  : ['仅返回受限结构化摘要；原始 JSON、完整正文、Cookie、Token 和资源内容不会写入应用状态。', '所有图层、资源和尺寸目前仍标记为 candidate，需确认字段语义后才能作为实现依据。']
              };
            })().then((value) => {
                window[probeKey] = { done: true, value };
              }).catch((error) => {
                window[probeKey] = { done: true, error: String(error) };
              });
              return probeKey;
            })()"#
                .replace("__PROBE_KEY__", &probe_key),
            |_| {},
        )
        .map_err(|error| error.to_string())?;

    let mut payload = None;
    for _ in 0..80 {
        let (sender, receiver) = mpsc::channel();
        let read_script = format!("JSON.stringify(window[{probe_key:?}] || null)",);
        webview
            .eval_with_callback(read_script, move |value| {
                let _ = sender.send(value);
            })
            .map_err(|error| error.to_string())?;
        let callback_value = tauri::async_runtime::spawn_blocking(move || {
            receiver.recv_timeout(Duration::from_millis(500))
        })
        .await
        .map_err(|error| format!("读取 Lake 结构化数据任务失败：{error}"))?
        .map_err(|error| format!("读取 Lake 结构化数据进度失败：{error}"))?;
        let progress: serde_json::Value = serde_json::from_str(&callback_value)
            .or_else(|_| {
                serde_json::from_str(
                    &serde_json::from_str::<String>(&callback_value).unwrap_or_default(),
                )
            })
            .map_err(|error| format!("解析 Lake 结构化数据进度失败：{error}"))?;
        if progress.get("done").and_then(serde_json::Value::as_bool) == Some(true) {
            if let Some(error) = progress.get("error").and_then(serde_json::Value::as_str) {
                return Err(format!("Lake 结构化数据探针执行失败：{error}"));
            }
            payload = progress.get("value").cloned();
            break;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    let value =
        payload.ok_or_else(|| "读取 Lake 结构化数据超时：页面异步请求未完成".to_string())?;

    serde_json::from_value(value)
        .map(Some)
        .map_err(|error| format!("Lake 结构化数据格式无效：{error}"))
}

#[tauri::command]
async fn get_lanhu_browser_snapshot(
    app: tauri::AppHandle,
) -> Result<Option<LanhuBrowserSnapshot>, String> {
    let Some(webview) = app.get_webview("lanhu-browser") else {
        return Ok(None);
    };

    let (sender, receiver) = mpsc::channel();
    webview
        .eval_with_callback(
            r#"(() => {
              const selectors = [
                ['data-node-id', '[data-node-id]'],
                ['data-id', '[data-id]'],
                ['data-layer-id', '[data-layer-id]'],
                ['data-element-id', '[data-element-id]']
              ];
              const platformContext = (() => {
                const candidates = Array.from(document.querySelectorAll('body *'))
                  .map((element) => {
                    const rect = element.getBoundingClientRect();
                    const style = window.getComputedStyle(element);
                    const text = (element.textContent || '').trim().replace(/\\s+/g, ' ');
                    const hint = `${element.id || ''} ${element.className || ''} ${element.getAttribute('aria-label') || ''} ${element.getAttribute('title') || ''}`.toLowerCase();
                    return { element, rect, style, text, hint };
                  })
                  .filter(({ rect, style, text, hint }) => {
                    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0' || rect.width <= 0 || rect.height <= 0) return false;
                    if (rect.y < 0 || rect.y > 180 || rect.x < window.innerWidth * 0.45 || text.length === 0 || text.length > 100) return false;
                    return /ios|iphone|ipad|android|web|网页|移动端|平台|设备|device|platform/i.test(`${text} ${hint}`);
                  })
                  .sort((a, b) => (a.rect.y - b.rect.y) || (b.rect.x - a.rect.x));
                const selected = candidates.find(({ text, hint }) => /ios|iphone|ipad|android|web|网页|移动端/i.test(`${text} ${hint}`));
                if (!selected) return null;
                const label = selected.text;
                const dimensions = label.match(/(\\d+(?:\\.\\d+)?)\\s*[x×]\\s*(\\d+(?:\\.\\d+)?)/i);
                const viewportWidth = dimensions ? Number(dimensions[1]) : null;
                const contentHeight = dimensions ? Number(dimensions[2]) : null;
                const normalized = label.toLowerCase();
                const kind = /android/.test(normalized) ? 'android' : /ios|iphone|ipad/.test(normalized) ? 'ios' : /web|网页/.test(normalized) ? 'web' : 'unknown';
                return {
                  label: label.slice(0, 100),
                  kind,
                  design_unit: kind === 'android' ? 'dp' : kind === 'ios' ? 'pt' : kind === 'web' ? 'px' : 'unknown',
                  viewport_width: Number.isFinite(viewportWidth) ? viewportWidth : null,
                  content_height: Number.isFinite(contentHeight) ? contentHeight : null,
                  scrollable: Number.isFinite(contentHeight) && Number.isFinite(viewportWidth) && contentHeight > viewportWidth,
                  confidence: 'candidate',
                  source: 'lanhu-platform-selector'
                };
              })();
              const candidates = [];
              const seen = new Set();
              for (const [markerType, selector] of selectors) {
                for (const element of document.querySelectorAll(selector)) {
                  const marker = element.getAttribute(markerType);
                  if (!marker || seen.has(marker)) continue;
                  seen.add(marker);
                  const rect = element.getBoundingClientRect();
                  const parent = element.parentElement?.closest('[data-node-id], [data-id], [data-layer-id], [data-element-id]');
                  const parentMarker = parent ? (parent.getAttribute('data-node-id') || parent.getAttribute('data-id') || parent.getAttribute('data-layer-id') || parent.getAttribute('data-element-id')) : null;
                  const style = window.getComputedStyle(element);
                  candidates.push({
                    marker,
                    marker_type: markerType,
                    tag_name: element.tagName.toLowerCase(),
                    class_name: element.getAttribute('class') || null,
                    role: element.getAttribute('role') || null,
                    svg_ancestor: Boolean(element.closest('svg')),
                    ancestor_depth: (() => { let depth = 0; let current = element.parentElement; while (current && depth < 32) { depth++; current = current.parentElement; } return depth; })(),
                    classification: (element.getAttribute('class') || '').includes('layers_item') ? 'page-ui' : 'unknown',
                    name: element.getAttribute('data-name') || element.getAttribute('aria-label') || element.getAttribute('title') || null,
                    parent_marker: parentMarker,
                    bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
                    visible: style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0
                  });
                }
              }
              return {
                url: window.location.href,
                title: document.title || '',
                ready_state: document.readyState || 'unknown',
                dom_element_count: document.querySelectorAll('*').length,
                node_marker_count: document.querySelectorAll('[data-node-id], [data-id], [data-layer-id], [data-element-id]').length,
                semantic_element_count: document.querySelectorAll('main, header, nav, section, article, form, button, input, textarea, label').length,
                content_editable_count: document.querySelectorAll('[contenteditable="true"]').length,
                body_text_length: (document.body?.innerText || '').length,
                image_count: document.images.length,
                canvas_count: document.querySelectorAll('canvas').length,
                svg_count: document.querySelectorAll('svg').length,
                iframe_count: document.querySelectorAll('iframe').length,
                shadow_root_count: Array.from(document.querySelectorAll('*')).filter((element) => Boolean(element.shadowRoot)).length,
                svg_summaries: Array.from(document.querySelectorAll('svg')).slice(0, 100).map((svg) => {
                  const rect = svg.getBoundingClientRect();
                  const style = window.getComputedStyle(svg);
                  return {
                    id: svg.getAttribute('id'),
                    class_name: svg.getAttribute('class'),
                    width: rect.width,
                    height: rect.height,
                    view_box: svg.getAttribute('viewBox'),
                    element_count: svg.querySelectorAll('*').length,
                    visible: style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0
                  };
                }),
                visible_surface_summaries: Array.from(document.querySelectorAll('body *'))
                  .map((element) => {
                    const rect = element.getBoundingClientRect();
                    const style = window.getComputedStyle(element);
                    return {
                      element,
                      rect,
                      style,
                      area: rect.width * rect.height,
                      image_descendant_count: element.querySelectorAll('img').length,
                      canvas_descendant_count: element.querySelectorAll('canvas').length,
                      svg_descendant_count: element.querySelectorAll('svg').length
                    };
                  })
                  .filter(({ element, rect, style, image_descendant_count, canvas_descendant_count, svg_descendant_count }) => {
                    const visible = style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0' && rect.width > 0 && rect.height > 0;
                    const large = rect.width >= 240 && rect.height >= 160;
                    const mediaContainer = image_descendant_count > 0 || canvas_descendant_count > 0 || svg_descendant_count > 0 || style.backgroundImage !== 'none';
                    return visible && (large || mediaContainer) && element.tagName.toLowerCase() !== 'svg';
                  })
                  .sort((a, b) => b.area - a.area)
                  .slice(0, 80)
                  .map(({ element, rect, style, image_descendant_count, canvas_descendant_count, svg_descendant_count }) => ({
                    tag_name: element.tagName.toLowerCase(),
                    id: element.getAttribute('id'),
                    class_name: element.getAttribute('class'),
                    role: element.getAttribute('role'),
                    width: rect.width,
                    height: rect.height,
                    child_element_count: element.children.length,
                    image_descendant_count,
                    canvas_descendant_count,
                    svg_descendant_count,
                    background_image: style.backgroundImage !== 'none'
                  })),
                image_summaries: Array.from(document.images)
                  .map((image) => {
                    const rect = image.getBoundingClientRect();
                    const style = window.getComputedStyle(image);
                    return {
                      id: image.getAttribute('id'),
                      class_name: image.getAttribute('class'),
                      width: rect.width,
                      height: rect.height,
                      natural_width: image.naturalWidth,
                      natural_height: image.naturalHeight,
                      visible: style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0' && rect.width > 0 && rect.height > 0
                    };
                  })
                  .sort((a, b) => (b.natural_width * b.natural_height) - (a.natural_width * a.natural_height))
                  .slice(0, 100),
                annotation_summaries: Array.from(document.querySelectorAll('body *'))
                  .map((element) => {
                    const rect = element.getBoundingClientRect();
                    const style = window.getComputedStyle(element);
                    const identity = `${element.id || ''} ${element.getAttribute('class') || ''}`.toLowerCase();
                    const text = (element.textContent || '').trim();
                    const matches = [...text.matchAll(/(-?\d+(?:\.\d+)?)\s*(px|百分比|%|rem|em|rpx)?/gi)];
                    return {
                      element,
                      rect,
                      style,
                      identity,
                      text_length: text.length,
                      numeric_values: matches.slice(0, 64).map((match) => Number(match[1])).filter((value) => Number.isFinite(value)),
                      measurements: matches.slice(0, 64).map((match) => ({
                        value: Number(match[1]),
                        unit: match[2] ? (match[2].toLowerCase() === '%' || match[2] === '百分比' ? 'percent' : match[2].toLowerCase()) : 'number'
                      })).filter((measurement) => Number.isFinite(measurement.value)),
                      likely_measurements: [...new Set(matches
                        .filter((match) => !match[2] || /px|%|rem|em|rpx|百分比/i.test(match[2]))
                        .map((match) => Number(match[1]))
                        .filter((value) => Number.isFinite(value) && value >= 0 && value <= 10000))].slice(0, 32),
                      px_value_count: matches.filter((match) => (match[2] || '').toLowerCase() === 'px').length
                    };
                  })
                  .filter(({ rect, style, identity }) => {
                    const visible = style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0' && rect.width > 0 && rect.height > 0;
                    return visible && /(annot|measure|ruler|dimension|spacing|distance|标注|间距|尺寸|规格|px)/i.test(identity);
                  })
                  .sort((a, b) => (b.rect.width * b.rect.height) - (a.rect.width * a.rect.height))
                  .slice(0, 50)
                  .map(({ element, rect, style, text_length, numeric_values, measurements, likely_measurements, px_value_count }) => ({
                    tag_name: element.tagName.toLowerCase(),
                    id: element.getAttribute('id'),
                    class_name: element.getAttribute('class'),
                    role: element.getAttribute('role'),
                    width: rect.width,
                    height: rect.height,
                    text_length,
                    numeric_values,
                    measurements,
                    likely_measurements,
                    px_value_count,
                    child_element_count: element.children.length,
                    visible: style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0'
                  })),
                platform_context: platformContext,
                node_candidates: candidates,
                node_candidate_limit_reached: false
              };
            })()"#,
            move |payload| {
                let _ = sender.send(payload);
            },
        )
        .map_err(|error| error.to_string())?;

    let payload =
        tauri::async_runtime::spawn_blocking(move || receiver.recv_timeout(Duration::from_secs(2)))
            .await
            .map_err(|error| format!("读取 Lake 页面信息任务失败：{error}"))?
            .map_err(|error| format!("读取 Lake 页面信息超时：{error}"))?;
    let value: serde_json::Value = serde_json::from_str(&payload)
        .map_err(|error| format!("解析 Lake 页面信息失败：{error}"))?;
    let value = if let serde_json::Value::String(serialized) = value {
        serde_json::from_str(&serialized)
            .map_err(|error| format!("解析 Lake 页面信息失败：{error}"))?
    } else {
        value
    };

    serde_json::from_value(value)
        .map(Some)
        .map_err(|error| format!("Lake 页面信息格式无效：{error}"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            app_info,
            load_app_state,
            save_app_state,
            configure_codex_mcp,
            get_mcp_connection_info,
            copy_text_to_clipboard,
            cleanup_asset_cache,
            get_lanhu_browser_url,
            open_lanhu_browser,
            focus_lanhu_browser,
            navigate_lanhu_browser,
            clear_lanhu_session,
            get_lanhu_browser_snapshot,
            get_lanhu_structured_data_probe,
            get_lake_session,
            fetch_lake_design_data
        ])
        .run(tauri::generate_context!())
        .expect("error while running Lake Catch");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_nested_layers_styles_and_assets() {
        let design = serde_json::json!({
            "artboard": {
                "id": "board",
                "type": "artboard",
                "frame": { "x": 0, "y": 0, "width": 750, "height": 1600 },
                "layers": [
                    {
                        "id": "title",
                        "name": "标题",
                        "type": "text",
                        "text": "Hello",
                        "frame": { "x": 20, "y": 40, "width": 300, "height": 42 },
                        "fontSize": 24,
                        "color": "#20242a"
                    },
                    {
                        "id": "hero",
                        "name": "主图",
                        "type": "image",
                        "frame": { "x": 0, "y": 100, "width": 750, "height": 420 },
                        "src": "https://assets.example.test/hero.png",
                        "opacity": 0.8,
                        "cornerRadius": 12
                    }
                ]
            }
        });

        let (layers, assets) = extract_layers(&design);
        assert_eq!(layers.len(), 3);
        assert_eq!(
            layers
                .iter()
                .find(|layer| layer.id == "title")
                .and_then(|layer| layer.text.as_deref()),
            Some("Hello")
        );
        assert_eq!(
            layers
                .iter()
                .find(|layer| layer.id == "hero")
                .and_then(|layer| layer.asset_url.as_deref()),
            Some("https://assets.example.test/hero.png")
        );
        assert_eq!(
            layers
                .iter()
                .find(|layer| layer.id == "title")
                .and_then(|layer| layer.style.as_ref()?.get("fontSize"))
                .and_then(serde_json::Value::as_f64),
            Some(24.0)
        );
        assert_eq!(assets.len(), 1);
        assert_eq!(assets[0].kind, "image");
    }

    #[test]
    fn uses_text_layer_name_when_design_json_omits_text_field() {
        let design = serde_json::json!({
            "layers": [
                {
                    "id": "headline",
                    "name": "真实标题",
                    "type": "textLayer",
                    "frame": { "x": 0, "y": 0, "width": 200, "height": 40 }
                },
                {
                    "id": "card",
                    "name": "普通容器",
                    "type": "group",
                    "frame": { "x": 0, "y": 48, "width": 200, "height": 100 }
                }
            ]
        });

        let (layers, _) = extract_layers(&design);
        assert_eq!(
            layers
                .iter()
                .find(|layer| layer.id == "headline")
                .and_then(|layer| layer.text.as_deref()),
            Some("真实标题")
        );
        assert_eq!(
            layers
                .iter()
                .find(|layer| layer.id == "card")
                .and_then(|layer| layer.text.as_deref()),
            None
        );
    }

    #[test]
    fn ignores_invalid_bounds_values() {
        let value = serde_json::json!({ "type": "shape", "bounds": { "x": "bad", "width": 20, "height": 10 } });
        let bounds = layer_bounds(&value).expect("bounds object should still be returned");
        assert_eq!(bounds.x, 0.0);
        assert_eq!(bounds.width, 20.0);
    }

    #[test]
    fn classifies_asset_density_and_download_policy() {
        let design = serde_json::json!({
            "layers": [
                { "id": "mdpi", "name": "icon_mdpi.png", "type": "image", "src": "https://assets.test/icon_mdpi.png" },
                { "id": "hdpi", "name": "icon.png", "type": "image", "src": "https://assets.test/drawable-hdpi/icon.png" },
                { "id": "xhdpi", "name": "icon_xhdpi.png", "type": "image", "src": "https://assets.test/icon_xhdpi.png" },
                { "id": "unknown", "name": "somehdpiasset.png", "type": "image", "src": "https://assets.test/somehdpiasset.png" }
            ]
        });

        let (_, assets) = extract_layers(&design);
        let asset = |id: &str| {
            assets
                .iter()
                .find(|item| item.id == format!("lake-asset:{id}"))
                .expect("asset should exist")
        };
        assert_eq!(asset("mdpi").density.as_deref(), Some("mdpi"));
        assert_eq!(asset("mdpi").download_policy, "skip-density-variant");
        assert_eq!(asset("hdpi").density.as_deref(), Some("hdpi"));
        assert_eq!(asset("hdpi").download_policy, "skip-density-variant");
        assert_eq!(asset("xhdpi").density.as_deref(), Some("xhdpi"));
        assert_eq!(asset("xhdpi").download_policy, "download-candidate");
        assert_eq!(asset("unknown").density, None);
        assert_eq!(asset("unknown").download_policy, "review");
    }

    #[test]
    fn reads_explicit_density_without_guessing_scale_as_hdpi() {
        let value = serde_json::json!({ "density": "hdpi", "name": "icon.png" });
        assert_eq!(
            asset_density(&value, "icon.png", None).as_deref(),
            Some("hdpi")
        );

        let scaled = serde_json::json!({ "scale": 2 });
        assert_eq!(
            asset_density(&scaled, "icon.png", None).as_deref(),
            Some("2x")
        );
        assert_eq!(asset_download_policy(Some("2x")), "download-candidate");
    }

    #[test]
    fn counts_shared_asset_references() {
        let design = serde_json::json!({
            "layers": [
                { "id": "hero", "type": "image", "src": "https://assets.test/shared@2x.png" },
                { "id": "thumbnail", "type": "image", "src": "https://assets.test/shared@2x.png" }
            ]
        });

        let (_, assets) = extract_layers(&design);
        assert_eq!(assets.len(), 1);
        assert_eq!(assets[0].reference_count, 2);
    }

    #[test]
    fn extracts_nested_asset_url_from_image_payload() {
        let design = serde_json::json!({
            "layers": [{
                "id": "nested-image",
                "name": "封面图",
                "type": "imageLayer",
                "image": { "resource": { "sourceUrl": "https://assets.test/cover@2x.png" } },
                "frame": { "x": 0, "y": 0, "width": 320, "height": 180 }
            }]
        });

        let (layers, assets) = extract_layers(&design);
        assert_eq!(
            layers
                .iter()
                .find(|layer| layer.id == "nested-image")
                .and_then(|layer| layer.asset_url.as_deref()),
            Some("https://assets.test/cover@2x.png")
        );
        assert_eq!(
            assets[0].source_url.as_deref(),
            Some("https://assets.test/cover@2x.png")
        );
    }

    #[test]
    fn computes_stable_asset_checksum() {
        assert_eq!(
            asset_checksum(b"lake"),
            "6f021f0268d5dd0d4e286ad5202f57335f2a8cc568704c4f7865c97879443ef8"
        );
        assert_eq!(asset_checksum(b"lake"), asset_checksum(b"lake"));
        assert_ne!(asset_checksum(b"lake"), asset_checksum(b"Lake"));
    }
}
