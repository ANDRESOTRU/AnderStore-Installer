use std::{
    path::{Path, PathBuf},
    sync::Mutex,
};

use crate::{
    device::{DeviceInfoMutex, get_provider, get_provider_from_connection, get_usbmuxd},
    error::AppError,
    operation::Operation,
    pairing::{get_sidestore_info, place_file},
};
use isideload::sideload::{application::SpecialApp, sideloader::Sideloader};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager, State, Window};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::time::{Duration, sleep};
use tracing::warn;

const UPDATES_URL: &str = "https://store.andresot.uk/updates.json";
const GITHUB_LATEST_RELEASE_URL: &str =
    "https://api.github.com/repos/ANDRESOTRU/AnderStore/releases/latest";
const ANDERSTORE_ASSET_NAME: &str = "AnderStore.ipa";

#[derive(Debug, Deserialize)]
struct UpdatesManifest {
    anderstore: UpdateArtifact,
}

#[derive(Debug, Deserialize, PartialEq, Eq)]
struct UpdateArtifact {
    version: String,
    url: String,
    sha256: String,
}

#[derive(Debug, Deserialize)]
struct GitHubRelease {
    tag_name: String,
    draft: bool,
    prerelease: bool,
    assets: Vec<GitHubReleaseAsset>,
}

#[derive(Debug, Deserialize)]
struct GitHubReleaseAsset {
    name: String,
    browser_download_url: String,
    digest: Option<String>,
}

pub type SideloaderMutex = Mutex<Option<Sideloader>>;

pub struct SideloaderGuard<'a> {
    state: &'a SideloaderMutex,
    sideloader: Option<Sideloader>,
}

impl<'a> SideloaderGuard<'a> {
    pub fn take(state: &'a SideloaderMutex) -> Result<Self, AppError> {
        let mut guard = state.lock().unwrap();
        let sideloader = guard.take().ok_or(AppError::NotLoggedIn)?;
        Ok(Self {
            state,
            sideloader: Some(sideloader),
        })
    }

    pub fn get_mut(&mut self) -> &mut Sideloader {
        self.sideloader
            .as_mut()
            .expect("Sideloader should be present")
    }
}

impl Drop for SideloaderGuard<'_> {
    fn drop(&mut self) {
        let mut guard = self.state.lock().unwrap();
        *guard = self.sideloader.take();
    }
}

pub async fn sideload(
    device_state: State<'_, DeviceInfoMutex>,
    sideloader_state: State<'_, SideloaderMutex>,
    app_path: String,
) -> Result<Option<SpecialApp>, AppError> {
    let device = {
        let device_lock = device_state.lock().unwrap();
        match &*device_lock {
            Some(d) => d.clone(),
            None => return Err(AppError::NoDeviceSelected),
        }
    };

    let provider = get_provider(&device.info).await?;

    let mut sideloader = SideloaderGuard::take(&sideloader_state)?;

    let special = sideloader
        .get_mut()
        .install_app(
            &provider,
            app_path.into(),
            false,
            None::<fn(f32) -> std::future::Ready<()>>,
        )
        .await?;

    Ok(special)
}

#[tauri::command]
pub async fn sideload_operation(
    window: Window,
    device_state: State<'_, DeviceInfoMutex>,
    sideloader_state: State<'_, SideloaderMutex>,
    app_path: String,
) -> Result<(), AppError> {
    let op = Operation::new("sideload".to_string(), &window);
    op.start("install")?;
    op.fail_if_err(
        "install",
        sideload(device_state, sideloader_state, app_path).await,
    )?;
    op.complete("install")?;
    Ok(())
}

#[tauri::command]
pub async fn install_sidestore_operation(
    handle: AppHandle,
    window: Window,
    device_state: State<'_, DeviceInfoMutex>,
    sideloader_state: State<'_, SideloaderMutex>,
    nightly: bool,
    live_container: bool,
) -> Result<(), AppError> {
    let op = Operation::new("install_sidestore".to_string(), &window);
    op.start("download")?;
    let _ = (nightly, live_container);
    let artifact = op.fail_if_err("download", fetch_anderstore_artifact().await)?;
    let cache_dir = handle
        .path()
        .app_cache_dir()
        .map_err(|e| AppError::Filesystem("Failed to get cache dir".into(), e.to_string()))?;
    op.fail_if_err(
        "download",
        tokio::fs::create_dir_all(&cache_dir)
            .await
            .map_err(|e| AppError::Filesystem("Failed to create cache dir".into(), e.to_string())),
    )?;
    let safe_version: String = artifact
        .version
        .chars()
        .filter(|character| {
            character.is_ascii_alphanumeric() || *character == '.' || *character == '-'
        })
        .collect();
    let dest = cache_dir.join(format!("AnderStore-{safe_version}.ipa"));

    let cached_is_valid = if tokio::fs::try_exists(&dest).await.unwrap_or(false) {
        checksum_matches(&dest, &artifact.sha256)
            .await
            .unwrap_or(false)
    } else {
        false
    };
    if !cached_is_valid {
        let partial = dest.with_extension("ipa.download");
        let _ = tokio::fs::remove_file(&partial).await;
        op.fail_if_err("download", download(&artifact.url, &partial).await)?;
        let actual = op.fail_if_err("download", sha256_file(&partial).await)?;
        if actual != artifact.sha256.to_lowercase() {
            let _ = tokio::fs::remove_file(&partial).await;
            return op.fail(
                "download",
                AppError::Download("AnderStore.ipa SHA-256 mismatch".into()),
            );
        }
        let _ = tokio::fs::remove_file(&dest).await;
        op.fail_if_err(
            "download",
            tokio::fs::rename(&partial, &dest).await.map_err(|e| {
                AppError::Filesystem("Failed to commit cached IPA".into(), e.to_string())
            }),
        )?;
    }
    op.move_on("download", "install")?;
    let device = {
        let device_guard = device_state.lock().unwrap();
        match &*device_guard {
            Some(d) => d.clone(),
            None => return op.fail("install", AppError::NoDeviceSelected),
        }
    };
    op.fail_if_err(
        "install",
        sideload(
            device_state,
            sideloader_state,
            dest.to_string_lossy().to_string(),
        )
        .await,
    )?;
    op.move_on("install", "pairing")?;
    let mut sidestore_info = None;
    for attempt in 0..4_u64 {
        sidestore_info = op.fail_if_err(
            "pairing",
            get_sidestore_info(&device.info, live_container).await,
        )?;
        if sidestore_info.is_some() {
            break;
        }
        if attempt < 3 {
            sleep(Duration::from_millis(500 * (attempt + 1))).await;
        }
    }
    if let Some(info) = sidestore_info {
        let mut usbmuxd = op.fail_if_err("pairing", get_usbmuxd().await)?;

        let provider = op.fail_if_err(
            "pairing",
            get_provider_from_connection(&device.info, &mut usbmuxd).await,
        )?;

        op.fail_if_err(
            "pairing",
            place_file(device.pairing, &provider, info.bundle_id, info.path).await,
        )?;
    } else {
        return op.fail(
            "pairing",
            AppError::HouseArrest(
                "AnderStore was not found after installation".into(),
                "The iPhone did not report AnderStore's bundle ID after four checks".into(),
            ),
        );
    }

    op.complete("pairing")?;
    Ok(())
}

pub async fn download(url: impl AsRef<str>, dest: &PathBuf) -> Result<(), AppError> {
    let mut response = reqwest::get(url.as_ref())
        .await
        .map_err(|e| AppError::Download(e.to_string()))?;
    if !response.status().is_success() {
        return Err(AppError::Download(format!(
            "Failed to download file: HTTP {}",
            response.status()
        )));
    }

    let mut file = tokio::fs::File::create(dest).await.map_err(|e| {
        AppError::Filesystem("Failed to create downloaded file".into(), e.to_string())
    })?;
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| AppError::Download(e.to_string()))?
    {
        file.write_all(&chunk).await.map_err(|e| {
            AppError::Filesystem("Failed to write downloaded file".into(), e.to_string())
        })?;
    }
    file.flush().await.map_err(|e| {
        AppError::Filesystem("Failed to finish downloaded file".into(), e.to_string())
    })?;

    Ok(())
}

fn validate_artifact(artifact: UpdateArtifact, source: &str) -> Result<UpdateArtifact, AppError> {
    if artifact.url.is_empty()
        || artifact.version.is_empty()
        || artifact.sha256.len() != 64
        || !artifact.sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(AppError::Download(format!(
            "{source} does not contain a complete AnderStore artifact"
        )));
    }
    Ok(UpdateArtifact {
        sha256: artifact.sha256.to_ascii_lowercase(),
        ..artifact
    })
}

fn parse_updates_manifest(body: &str) -> Result<UpdateArtifact, AppError> {
    let manifest: UpdatesManifest = serde_json::from_str(body)
        .map_err(|error| AppError::Download(format!("Invalid updates.json: {error}")))?;
    validate_artifact(manifest.anderstore, "updates.json")
}

fn parse_github_release(body: &str) -> Result<UpdateArtifact, AppError> {
    let release: GitHubRelease = serde_json::from_str(body)
        .map_err(|error| AppError::Download(format!("Invalid GitHub release response: {error}")))?;
    if release.draft || release.prerelease {
        return Err(AppError::Download(
            "GitHub returned a draft or prerelease instead of a stable AnderStore release".into(),
        ));
    }

    let version = release
        .tag_name
        .strip_prefix('v')
        .unwrap_or(&release.tag_name)
        .to_string();
    if version.is_empty() || version.eq_ignore_ascii_case("nightly") {
        return Err(AppError::Download(
            "GitHub release does not contain a stable version tag".into(),
        ));
    }

    let asset = release
        .assets
        .into_iter()
        .find(|asset| asset.name == ANDERSTORE_ASSET_NAME)
        .ok_or_else(|| {
            AppError::Download(format!(
                "GitHub release does not contain {ANDERSTORE_ASSET_NAME}"
            ))
        })?;
    let digest = asset.digest.ok_or_else(|| {
        AppError::Download(format!(
            "GitHub did not provide a SHA-256 digest for {ANDERSTORE_ASSET_NAME}"
        ))
    })?;
    let sha256 = digest
        .strip_prefix("sha256:")
        .ok_or_else(|| AppError::Download("GitHub asset digest is not SHA-256".into()))?
        .to_string();

    validate_artifact(
        UpdateArtifact {
            version,
            url: asset.browser_download_url,
            sha256,
        },
        "GitHub release",
    )
}

async fn fetch_updates_artifact() -> Result<UpdateArtifact, AppError> {
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|error| AppError::Download(format!("Failed to create HTTP client: {error}")))?;
    let response = client
        .get(UPDATES_URL)
        .send()
        .await
        .map_err(|error| AppError::Download(format!("updates.json request failed: {error}")))?;
    if response.status().is_redirection() {
        return Err(AppError::Download(format!(
            "updates.json redirected with HTTP {}",
            response.status()
        )));
    }
    if !response.status().is_success() {
        return Err(AppError::Download(format!(
            "updates.json: HTTP {}",
            response.status()
        )));
    }
    let body = response
        .text()
        .await
        .map_err(|error| AppError::Download(format!("Failed to read updates.json: {error}")))?;
    parse_updates_manifest(&body)
}

async fn fetch_github_artifact() -> Result<UpdateArtifact, AppError> {
    let response = reqwest::Client::new()
        .get(GITHUB_LATEST_RELEASE_URL)
        .header(reqwest::header::ACCEPT, "application/vnd.github+json")
        .header(reqwest::header::USER_AGENT, "AnderStore-Installer")
        .send()
        .await
        .map_err(|error| AppError::Download(format!("GitHub release request failed: {error}")))?;
    if !response.status().is_success() {
        return Err(AppError::Download(format!(
            "GitHub release: HTTP {}",
            response.status()
        )));
    }
    let body = response.text().await.map_err(|error| {
        AppError::Download(format!("Failed to read GitHub release response: {error}"))
    })?;
    parse_github_release(&body)
}

async fn fetch_anderstore_artifact() -> Result<UpdateArtifact, AppError> {
    match fetch_updates_artifact().await {
        Ok(artifact) => Ok(artifact),
        Err(primary_error) => {
            warn!(
                error = %primary_error,
                "updates.json is unavailable; using the latest stable GitHub release"
            );
            fetch_github_artifact().await.map_err(|fallback_error| {
                AppError::Download(format!(
                    "Unable to resolve AnderStore IPA. Primary source: {primary_error}. GitHub fallback: {fallback_error}"
                ))
            })
        }
    }
}

async fn sha256_file(path: &Path) -> Result<String, AppError> {
    let mut file = tokio::fs::File::open(path).await.map_err(|error| {
        AppError::Filesystem("Failed to open file for checksum".into(), error.to_string())
    })?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; 1024 * 1024];
    loop {
        let count = file.read(&mut buffer).await.map_err(|error| {
            AppError::Filesystem("Failed to read file for checksum".into(), error.to_string())
        })?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

async fn checksum_matches(path: &Path, expected: &str) -> Result<bool, AppError> {
    Ok(sha256_file(path).await? == expected.to_ascii_lowercase())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_update_manifest() {
        let artifact = parse_updates_manifest(r#"{
            "anderstore":{"version":"1.6.0","url":"https://example.test/app.ipa","sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}
        }"#).expect("manifest should parse");
        assert_eq!(artifact.version, "1.6.0");
        assert_eq!(artifact.sha256.len(), 64);
    }

    #[test]
    fn rejects_html_instead_of_updates_manifest() {
        assert!(parse_updates_manifest("<!doctype html><title>Download</title>").is_err());
    }

    #[test]
    fn parses_stable_github_release_asset() {
        let artifact = parse_github_release(
            r#"{
            "tag_name":"v1.6.42",
            "draft":false,
            "prerelease":false,
            "assets":[{
                "name":"AnderStore.ipa",
                "browser_download_url":"https://github.example/AnderStore.ipa",
                "digest":"sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
            }]
        }"#,
        )
        .expect("GitHub release should parse");
        assert_eq!(artifact.version, "1.6.42");
        assert_eq!(artifact.sha256, "b".repeat(64));
    }

    #[test]
    fn rejects_github_asset_without_sha256() {
        let result = parse_github_release(
            r#"{
            "tag_name":"v1.6.42",
            "draft":false,
            "prerelease":false,
            "assets":[{
                "name":"AnderStore.ipa",
                "browser_download_url":"https://github.example/AnderStore.ipa",
                "digest":null
            }]
        }"#,
        );
        assert!(result.is_err());
    }

    #[test]
    fn rejects_prerelease_as_production_fallback() {
        let result = parse_github_release(
            r#"{
            "tag_name":"nightly",
            "draft":false,
            "prerelease":true,
            "assets":[]
        }"#,
        );
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn rejects_cached_ipa_with_wrong_hash() {
        let path = std::env::temp_dir().join(format!(
            "anderstore-checksum-{}-{}.ipa",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("system clock")
                .as_nanos()
        ));
        tokio::fs::write(&path, b"not an ipa")
            .await
            .expect("test file");
        let matches = checksum_matches(&path, &"0".repeat(64))
            .await
            .expect("checksum");
        let _ = tokio::fs::remove_file(&path).await;
        assert!(!matches);
    }
}
