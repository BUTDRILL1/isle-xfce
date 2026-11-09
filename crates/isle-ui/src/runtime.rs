// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

//! Embedded GJS runtime integration for running upstream Isle JavaScript components.

use std::ffi::CString;
use log::{error, info};

#[link(name = "gjs")]
unsafe extern "C" {
    fn gjs_context_new() -> *mut std::ffi::c_void;
    #[allow(dead_code)]
    fn gjs_context_eval(
        js_context: *mut std::ffi::c_void,
        script: *const std::ffi::c_char,
        script_len: isize,
        filename: *const std::ffi::c_char,
        exit_status_p: *mut i32,
        error: *mut *mut std::ffi::c_void,
    ) -> i32;
    fn gjs_context_eval_module_file(
        js_context: *mut std::ffi::c_void,
        filename: *const std::ffi::c_char,
        exit_status_p: *mut u8,
        error: *mut *mut std::ffi::c_void,
    ) -> i32;
}

pub struct GjsRuntime {
    ctx: *mut std::ffi::c_void,
}

impl GjsRuntime {
    pub fn new() -> Option<Self> {
        let ctx = unsafe { gjs_context_new() };
        if ctx.is_null() {
            error!("Failed to create GJS context");
            None
        } else {
            info!("Initialized embedded GJS runtime context");
            Some(Self { ctx })
        }
    }

    #[allow(dead_code)]
    pub fn eval(&self, script: &str, filename: &str) -> Result<i32, String> {
        let c_script = CString::new(script).map_err(|e| e.to_string())?;
        let c_filename = CString::new(filename).map_err(|e| e.to_string())?;
        let mut exit_status: i32 = 0;
        let mut gerror: *mut std::ffi::c_void = std::ptr::null_mut();

        let ok = unsafe {
            gjs_context_eval(
                self.ctx,
                c_script.as_ptr(),
                c_script.as_bytes().len() as isize,
                c_filename.as_ptr(),
                &mut exit_status,
                &mut gerror,
            )
        };

        if ok != 0 {
            Ok(exit_status)
        } else {
            Err(format!("GJS evaluation failed with exit status {exit_status}"))
        }
    }

    pub fn eval_module_file(&self, filename: &str) -> Result<u8, String> {
        let c_filename = CString::new(filename).map_err(|e| e.to_string())?;
        let mut exit_status: u8 = 0;
        let mut gerror: *mut std::ffi::c_void = std::ptr::null_mut();

        let ok = unsafe {
            gjs_context_eval_module_file(
                self.ctx,
                c_filename.as_ptr(),
                &mut exit_status,
                &mut gerror,
            )
        };

        if ok != 0 {
            Ok(exit_status)
        } else {
            Err(format!("GJS module evaluation failed with exit status {exit_status}"))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_gjs_eval_basic() {
        let runtime = GjsRuntime::new().expect("Runtime creation failed");
        let res = runtime.eval("const x = 40 + 2; print('Evaluated in test:', x);", "<test>");
        assert!(res.is_ok());
    }
}
