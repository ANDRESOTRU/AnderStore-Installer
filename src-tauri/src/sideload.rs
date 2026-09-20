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

const UPDATES_URL: &str = "https://store.andresot.uk/updates.json";

#[derive(Debug, Deserialize)]
struct UpdatesManifest {
    anderstore: UpdateArtifact,
}

#[derive(Debug, Deserialize)]
struct UpdateArtifact {
    version: String,
    url: String,
    sha256: String,
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
    let sidestore_info = op.fail_if_err(
        "pairing",
        get_sidestore_info(&device.info, live_container).await,
    )?;
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
                "SideStore's not found".into(),
                "The device did not report SideStore's bundle ID as installed".into(),
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

async fn fetch_anderstore_artifact() -> Result<UpdateArtifact, AppError> {
    let response = reqwest::get(UPDATES_URL)
        .await
        .map_err(|error| AppError::Download(error.to_string()))?;
    if !response.status().is_success() {
        return Err(AppError::Download(format!(
            "updates.json: HTTP {}",
            response.status()
        )));
    }
    let manifest: UpdatesManifest = response
        .json()
        .await
        .map_err(|error| AppError::Download(format!("Invalid updates.json: {error}")))?;
    let artifact = manifest.anderstore;
    if artifact.url.is_empty()
        || artifact.version.is_empty()
        || artifact.sha256.len() != 64
        || !artifact.sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(AppError::Download(
            "updates.json does not contain a complete AnderStore artifact".into(),
        ));
    }
    Ok(artifact)
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
        let manifest: UpdatesManifest = serde_json::from_str(r#"{
            "anderstore":{"version":"1.6.0","url":"https://example.test/app.ipa","sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}
        }"#).expect("manifest should parse");
        assert_eq!(manifest.anderstore.version, "1.6.0");
        assert_eq!(manifest.anderstore.sha256.len(), 64);
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
