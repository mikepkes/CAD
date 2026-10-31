//! 3D mouse (3Dconnexion SpaceMouse) for the desktop app. WKWebView has no
//! WebHID, so a thread here finds the device, reads its HID reports and
//! forwards them raw to the webview as `spacemouse-report` events; the page
//! parses them (src/viewport/spaceMouse.ts), the same as WebHID reports in a
//! browser. The device is opened non-exclusively; 3Dconnexion's current macOS
//! driver holds it exclusively all the same, so with 3DxWare installed the app
//! goes through the driver instead (connexion.rs) and this reader isn't started.

use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter};

/// 3Dconnexion's vendor id, and Logitech's (older 3Dconnexion devices).
const VENDORS: [u16; 2] = [0x256f, 0x046d];

/// A multi-axis controller (HID Generic Desktop page 1, usage 8) from a 3D-mouse vendor.
/// The usage check keeps ordinary Logitech mice and keyboards out.
pub fn is_spacemouse(vendor: u16, usage_page: u16, usage: u16) -> bool {
    VENDORS.contains(&vendor) && usage_page == 1 && usage == 8
}

/// What the page shows in Settings.
#[derive(Clone, Default, Serialize)]
pub struct Status {
    pub product: Option<String>,
    pub note: Option<String>,
}

/// One HID input report for the page (`data` without the report id).
#[derive(Clone, Serialize)]
pub struct Report {
    pub id: u8,
    pub data: Vec<u8>,
}

/// Shared with the `spacemouse_status` command.
#[derive(Clone, Default)]
pub struct SpaceMouse(pub Arc<Mutex<Status>>);

impl SpaceMouse {
    pub fn set(&self, app: &AppHandle, status: Status) {
        *self.0.lock().unwrap() = status.clone();
        let _ = app.emit("spacemouse-status", status);
    }
}

/// Start the reader thread: look for a device every couple of seconds, and
/// while one is open forward each report. Unplugging it reports a disconnect
/// (the page lets go of any held motion) and the search resumes.
pub fn start(app: AppHandle, shared: SpaceMouse) {
    thread::spawn(move || {
        let mut api = match hidapi::HidApi::new() {
            Ok(api) => api,
            Err(e) => {
                shared.set(&app, Status { product: None, note: Some(format!("HID unavailable: {e}")) });
                return;
            }
        };
        loop {
            let _ = api.refresh_devices();
            let found = api
                .device_list()
                .find(|d| is_spacemouse(d.vendor_id(), d.usage_page(), d.usage()))
                .map(|d| (d.clone(), d.product_string().unwrap_or("3D mouse").to_string()));
            let Some((info, product)) = found else {
                if shared.0.lock().unwrap().product.is_some() {
                    shared.set(&app, Status { product: None, note: Some("The 3D mouse was disconnected.".into()) });
                }
                thread::sleep(Duration::from_secs(2));
                continue;
            };
            match info.open_device(&api) {
                Ok(dev) => {
                    shared.set(&app, Status { product: Some(product), note: None });
                    let mut buf = [0u8; 64];
                    loop {
                        match dev.read_timeout(&mut buf, 250) {
                            Ok(0) => continue,
                            Ok(n) => {
                                let _ = app.emit("spacemouse-report", Report { id: buf[0], data: buf[1..n].to_vec() });
                            }
                            Err(_) => break, // unplugged
                        }
                    }
                    shared.set(&app, Status { product: None, note: Some("The 3D mouse was disconnected.".into()) });
                }
                Err(e) => {
                    shared.set(&app, Status { product: None, note: Some(format!("Found {product} but couldn't open it ({e}); another app or 3Dconnexion's driver may hold it.")) });
                    thread::sleep(Duration::from_secs(5));
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::is_spacemouse;

    #[test]
    fn only_multi_axis_controllers_from_3d_mouse_vendors() {
        assert!(is_spacemouse(0x256f, 1, 8)); // SpaceMouse
        assert!(is_spacemouse(0x046d, 1, 8)); // older 3Dconnexion under Logitech's id
        assert!(!is_spacemouse(0x046d, 1, 2)); // a Logitech mouse
        assert!(!is_spacemouse(0x046d, 1, 6)); // a Logitech keyboard
        assert!(!is_spacemouse(0x1234, 1, 8)); // someone else's joystick
    }
}
