// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

//! Low-level X11 helpers using x11rb and GDK4-X11.

use gtk::prelude::*;
use gtk4 as gtk;
use x11rb::connection::Connection as _;
use x11rb::protocol::xproto::{
    ChangeWindowAttributesAux, ConfigureWindowAux, ConnectionExt as _, StackMode, Window,
};
use x11rb::rust_connection::RustConnection;

pub type Error = Box<dyn std::error::Error + Send + Sync>;

/// Encapsulates a persistent connection to the X11 display server.
pub struct X11Context {
    conn: RustConnection,
}

impl X11Context {
    /// Opens a single shared X11 connection.
    pub fn new() -> Result<Self, Error> {
        let (conn, _) = x11rb::connect(None)?;
        Ok(Self { conn })
    }

    /// Returns a reference to the underlying x11rb connection.
    #[allow(dead_code)]
    pub fn connection(&self) -> &RustConnection {
        &self.conn
    }

    /// Sets the `override_redirect` attribute on the given X11 window.
    ///
    /// Must be called after the window is realized but before it is mapped,
    /// so the window manager never receives a MapRequest.
    pub fn set_override_redirect(&self, xid: Window, override_redirect: bool) -> Result<(), Error> {
        let val = if override_redirect { 1 } else { 0 };
        let attrs = ChangeWindowAttributesAux::new().override_redirect(val);
        self.conn.change_window_attributes(xid, &attrs)?.check()?;
        self.conn.flush()?;
        Ok(())
    }

    /// Positions and sizes an override-redirect window in screen coordinates.
    pub fn configure_geometry(
        &self,
        xid: Window,
        x: i32,
        y: i32,
        width: u32,
        height: u32,
    ) -> Result<(), Error> {
        let geom = ConfigureWindowAux::new()
            .x(x)
            .y(y)
            .width(width)
            .height(height);
        self.conn.configure_window(xid, &geom)?.check()?;
        self.conn.flush()?;
        Ok(())
    }

    /// Raises the window to the top of the stacking order.
    pub fn restack_above(&self, xid: Window) -> Result<(), Error> {
        let geom = ConfigureWindowAux::new().stack_mode(StackMode::ABOVE);
        self.conn.configure_window(xid, &geom)?.check()?;
        self.conn.flush()?;
        Ok(())
    }
}

/// Flushes GDK's queued display requests to ensure order of operations with X11.
pub fn sync_gdk(window: &gtk::Window) {
    WidgetExt::display(window).sync();
}

/// Retrieves the X11 Window ID from a realized GTK4 window.
pub fn get_x11_window(window: &gtk::Window) -> Option<Window> {
    let surface = window.surface()?;
    let x11_surface = surface.downcast_ref::<gdk4_x11::X11Surface>()?;
    Some(x11_surface.xid() as Window)
}
