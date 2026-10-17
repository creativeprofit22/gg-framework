//! Developer-fixture-only native readback. No requested color or target label is
//! accepted: sample the calling window's actual Tao background paint handler.
#[tauri::command]
pub fn appearance_background_probe(window: tauri::Window) -> Result<String, String> {
    if !super::phase25_dev_fixture_enabled() {
        return Err("Native background probe requires an isolated developer fixture".into());
    }
    let hwnd = window.hwnd().map_err(|e| e.to_string())?;
    // Same process as the native window: GDI handles cannot cross processes.
    unsafe { windows_probe::read(hwnd.0 as isize) }
}

mod windows_probe {
    #[repr(C)]
    #[derive(Default)]
    struct Rect {
        left: i32,
        top: i32,
        right: i32,
        bottom: i32,
    }
    #[link(name = "user32")]
    extern "system" {
        fn GetDC(hwnd: isize) -> isize;
        fn ReleaseDC(hwnd: isize, dc: isize) -> i32;
        fn GetClientRect(hwnd: isize, rect: *mut Rect) -> i32;
        fn SendMessageW(hwnd: isize, msg: u32, wparam: usize, lparam: isize) -> isize;
    }
    #[link(name = "gdi32")]
    extern "system" {
        fn CreateCompatibleDC(dc: isize) -> isize;
        fn CreateCompatibleBitmap(dc: isize, width: i32, height: i32) -> isize;
        fn SelectObject(dc: isize, object: isize) -> isize;
        fn DeleteObject(object: isize) -> i32;
        fn DeleteDC(dc: isize) -> i32;
        fn SetPixel(dc: isize, x: i32, y: i32, color: u32) -> u32;
        fn GetPixel(dc: isize, x: i32, y: i32) -> u32;
    }
    struct Surface {
        screen: isize,
        dc: isize,
        bitmap: isize,
        previous: isize,
    }
    impl Drop for Surface {
        fn drop(&mut self) {
            unsafe {
                if self.previous != 0 && self.previous != -1 {
                    SelectObject(self.dc, self.previous);
                }
                if self.bitmap != 0 {
                    DeleteObject(self.bitmap);
                }
                if self.dc != 0 {
                    DeleteDC(self.dc);
                }
                if self.screen != 0 {
                    ReleaseDC(0, self.screen);
                }
            }
        }
    }
    pub unsafe fn read(hwnd: isize) -> Result<String, String> {
        let mut rect = Rect::default();
        if GetClientRect(hwnd, &mut rect) == 0 || rect.right <= 0 || rect.bottom <= 0 {
            return Err("Native client area is empty".into());
        }
        let mut surface = Surface {
            screen: GetDC(0),
            dc: 0,
            bitmap: 0,
            previous: 0,
        };
        if surface.screen == 0 {
            return Err("Cannot acquire native screen DC".into());
        }
        surface.dc = CreateCompatibleDC(surface.screen);
        surface.bitmap = CreateCompatibleBitmap(surface.screen, 1, 1);
        if surface.dc == 0 || surface.bitmap == 0 {
            return Err("Cannot allocate native readback surface".into());
        }
        surface.previous = SelectObject(surface.dc, surface.bitmap);
        if surface.previous == 0 || surface.previous == -1 {
            return Err("Cannot select native readback bitmap".into());
        }
        if SetPixel(surface.dc, 0, 0, 0x00ff00ff) == 0xffffffff {
            return Err("Cannot initialize native readback pixel".into());
        }
        // WM_ERASEBKGND invokes Tao's current background brush, without painting
        // the webview, changing the window, or accepting a color from JavaScript.
        if SendMessageW(hwnd, 0x0014, surface.dc as usize, 0) == 0 {
            return Err("Native background erasure was not handled".into());
        }
        let pixel = GetPixel(surface.dc, 0, 0);
        if pixel == 0xffffffff || pixel == 0x00ff00ff {
            return Err("Native background pixel was not painted".into());
        }
        Ok(format!(
            "#{:02x}{:02x}{:02x}",
            pixel & 255,
            (pixel >> 8) & 255,
            (pixel >> 16) & 255
        ))
    }
}
