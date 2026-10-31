//! 3D mouse through 3Dconnexion's own driver (3DxWare) on macOS. The driver
//! holds the device exclusively, so the raw HID reader (spacemouse.rs) can't
//! open it; instead the app registers as a client of the driver's framework,
//! loaded at run time so Macs without 3DxWare are unaffected. Device states
//! are re-encoded as the HID reports the page already parses
//! (src/viewport/spaceMouse.ts): report 1 = six axes, report 3 = buttons.
//!
//! The client is registered "manually" and switched on while the app's window
//! has focus, so the driver keeps serving other apps when Chisel is behind.

use std::ffi::{c_void, CStr};
use std::sync::atomic::{AtomicU16, Ordering};
use std::sync::OnceLock;

use tauri::{AppHandle, Emitter};

use crate::spacemouse::{Report, SpaceMouse, Status};

const FRAMEWORK: &CStr = c"/Library/Frameworks/3DconnexionClient.framework/3DconnexionClient";

/// Signature for a client switched on and off by the app itself ('++++').
const CLIENT_MANUAL: u32 = 0x2B2B2B2B;
/// Take the device over: the driver hands every axis and button to the app.
const MODE_TAKE_OVER: u16 = 1;
const MASK_ALL: u32 = 0x3FFF;
const BUTTONS_ALL: u32 = 0xFFFF_FFFF;
const CTL_ACTIVATE: u32 = 0x33646163; // '3dac'
const CTL_DEACTIVATE: u32 = 0x33646463; // '3ddc'
const MSG_DEVICE_STATE: u32 = 0x33645352; // '3dSR'
const CMD_BUTTONS: u16 = 2;
const CMD_AXIS: u16 = 3;

/// Full deflection as the driver reports it (raw HID reports ±350, which the page expects).
const DRIVER_FULL_SCALE: i32 = 520;
const HID_FULL_SCALE: i32 = 350;

/// The driver's device state message (2-byte packing, 48 bytes).
#[repr(C, packed(2))]
#[derive(Clone, Copy)]
struct DeviceState {
    version: u16,
    client: u16,
    command: u16,
    param: i16,
    value: i32,
    time: u64,
    report: [u8; 8],
    buttons8: u16,
    axis: [i16; 6], // x, y, z, rx, ry, rz
    address: u16,
    buttons: u32,
}
const _: () = assert!(std::mem::size_of::<DeviceState>() == 48);

type MessageHandler = extern "C" fn(u32, u32, *mut c_void);
type DeviceHandler = extern "C" fn(u32);

struct Client {
    control: unsafe extern "C" fn(u16, u32, i32, *mut i32) -> i16,
    app: AppHandle,
    shared: SpaceMouse,
}

static CLIENT: OnceLock<Client> = OnceLock::new();
/// The driver's id for this client (0 until registered).
static CLIENT_ID: AtomicU16 = AtomicU16::new(0);

/// Six driver axes as a HID report 1 (int16 LE each), rescaled to the HID range.
pub fn axes_report(axis: [i16; 6]) -> Vec<u8> {
    axis.iter()
        .flat_map(|&v| {
            let hid = (v as i32 * HID_FULL_SCALE / DRIVER_FULL_SCALE).clamp(i16::MIN as i32, i16::MAX as i32) as i16;
            hid.to_le_bytes()
        })
        .collect()
}

/// A Pascal string (length byte first), as the framework takes names.
pub fn pascal(name: &str) -> Vec<u8> {
    let bytes = &name.as_bytes()[..name.len().min(255)];
    let mut out = vec![bytes.len() as u8];
    out.extend_from_slice(bytes);
    out
}

fn emit(report: Report) {
    if let Some(c) = CLIENT.get() {
        let _ = c.app.emit("spacemouse-report", report);
    }
}

extern "C" fn on_message(_product: u32, kind: u32, arg: *mut c_void) {
    if CLIENT.get().is_none() || kind != MSG_DEVICE_STATE || arg.is_null() {
        return;
    }
    // SAFETY: for '3dSR' messages the driver passes a ConnexionDeviceState.
    let s = unsafe { std::ptr::read_unaligned(arg as *const DeviceState) };
    if s.client != CLIENT_ID.load(Ordering::Relaxed) {
        return;
    }
    match s.command {
        CMD_AXIS => emit(Report { id: 1, data: axes_report(s.axis) }),
        CMD_BUTTONS => emit(Report { id: 3, data: s.buttons.to_le_bytes().to_vec() }),
        _ => {}
    }
}

/// The product name the device gives over USB (enumerating doesn't need to open it).
fn product_name(product_id: u32) -> String {
    hidapi::HidApi::new()
        .ok()
        .and_then(|api| {
            api.device_list()
                .find(|d| d.vendor_id() == 0x256f && d.product_id() as u32 == product_id)
                .and_then(|d| d.product_string().map(str::to_string))
        })
        .unwrap_or_else(|| "3D mouse".into())
}

extern "C" fn on_added(product: u32) {
    if let Some(c) = CLIENT.get() {
        c.shared.set(&c.app, Status { product: Some(format!("{} (3DxWare)", product_name(product))), note: None });
    }
}

extern "C" fn on_removed(_product: u32) {
    if let Some(c) = CLIENT.get() {
        c.shared.set(&c.app, Status { product: None, note: Some("The 3D mouse was disconnected.".into()) });
    }
}

/// Register with 3DxWare when it's installed. Must run on the main thread: the
/// driver delivers messages on the main run loop. False when the framework is
/// missing or the driver isn't answering (the raw HID reader is used instead).
pub fn start(app: AppHandle, shared: SpaceMouse) -> bool {
    unsafe {
        let lib = libc::dlopen(FRAMEWORK.as_ptr(), libc::RTLD_NOW | libc::RTLD_LOCAL);
        if lib.is_null() {
            return false;
        }
        let sym = |name: &CStr| libc::dlsym(lib, name.as_ptr());
        let (set, register, buttons, control) = (sym(c"SetConnexionHandlers"), sym(c"RegisterConnexionClient"), sym(c"SetConnexionClientButtonMask"), sym(c"ConnexionClientControl"));
        if [set, register, buttons, control].iter().any(|p| p.is_null()) {
            return false;
        }
        let set: unsafe extern "C" fn(MessageHandler, DeviceHandler, DeviceHandler, bool) -> i16 = std::mem::transmute(set);
        let register: unsafe extern "C" fn(u32, *const u8, u16, u32) -> u16 = std::mem::transmute(register);
        let buttons: unsafe extern "C" fn(u16, u32) = std::mem::transmute(buttons);
        let control: unsafe extern "C" fn(u16, u32, i32, *mut i32) -> i16 = std::mem::transmute(control);

        if set(on_message, on_added, on_removed, false) != 0 {
            return false;
        }
        // the client must exist before registering: the driver announces the device straight away
        let _ = CLIENT.set(Client { control, app, shared });
        let name = pascal("Chisel CAD");
        let id = register(CLIENT_MANUAL, name.as_ptr(), MODE_TAKE_OVER, MASK_ALL);
        if id == 0 {
            return false;
        }
        buttons(id, BUTTONS_ALL);
        CLIENT_ID.store(id, Ordering::Relaxed);
        focus(true);
        true
    }
}

/// Take the device while the window has focus; let go (and stop any held motion) when it loses it.
pub fn focus(focused: bool) {
    let (Some(c), id) = (CLIENT.get(), CLIENT_ID.load(Ordering::Relaxed)) else { return };
    if id == 0 {
        return;
    }
    let mut result = 0;
    unsafe { (c.control)(id, if focused { CTL_ACTIVATE } else { CTL_DEACTIVATE }, 0, &mut result) };
    if !focused {
        emit(Report { id: 1, data: axes_report([0; 6]) });
        emit(Report { id: 3, data: vec![0; 4] });
    }
}

#[cfg(test)]
mod tests {
    use super::{axes_report, pascal};

    #[test]
    fn driver_axes_become_a_hid_report() {
        let r = axes_report([520, -520, 0, 260, -1, 30000]);
        let v: Vec<i16> = r.chunks_exact(2).map(|c| i16::from_le_bytes([c[0], c[1]])).collect();
        assert_eq!(v, vec![350, -350, 0, 175, 0, 20192]);
    }

    #[test]
    fn names_are_pascal_strings() {
        assert_eq!(pascal("Chisel"), b"\x06Chisel".to_vec());
    }
}
