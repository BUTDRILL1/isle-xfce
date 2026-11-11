// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

//! `isle-ui`: Native floating notch application for XFCE/X11.

mod runtime;
mod shader;
mod spring;
mod window;
mod x11;

use std::cell::RefCell;
use std::env;

use gtk::{gdk, gio, glib, prelude::*};
use gtk4 as gtk;
use log::info;

use crate::window::FloatingWindow;

const APP_ID: &str = "io.github.zickrian.isle.Ui";

thread_local! {
    static ACTIVE_WINDOW: RefCell<Option<FloatingWindow>> = const { RefCell::new(None) };
}

fn handle_cli_args() {
    let mut args = env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--assistant" => {
                if let Err(err) = std::fs::write("/tmp/isle_assistant", "open") {
                    eprintln!("Failed to write to /tmp/isle_assistant: {err}");
                    std::process::exit(1);
                }
                std::process::exit(0);
            }
            "--toggle" => {
                if let Err(err) = std::fs::write("/tmp/isle_assistant", "toggle") {
                    eprintln!("Failed to write to /tmp/isle_assistant: {err}");
                    std::process::exit(1);
                }
                std::process::exit(0);
            }
            "--tab" => {
                if let Some(tab_name) = args.next() {
                    if let Err(err) = std::fs::write("/tmp/isle_tab", tab_name) {
                        eprintln!("Failed to write to /tmp/isle_tab: {err}");
                        std::process::exit(1);
                    }
                    std::process::exit(0);
                } else {
                    eprintln!("Error: --tab requires a tab name argument");
                    eprintln!("Usage: isle-ui [--assistant | --toggle | --tab <name>]");
                    std::process::exit(1);
                }
            }
            opt if opt.starts_with("--tab=") => {
                let tab_name = &opt["--tab=".len()..];
                if tab_name.is_empty() {
                    eprintln!("Error: --tab requires a tab name argument");
                    eprintln!("Usage: isle-ui [--assistant | --toggle | --tab <name>]");
                    std::process::exit(1);
                }
                if let Err(err) = std::fs::write("/tmp/isle_tab", tab_name) {
                    eprintln!("Failed to write to /tmp/isle_tab: {err}");
                    std::process::exit(1);
                }
                std::process::exit(0);
            }
            "--help" | "-h" => {
                println!("Usage: isle-ui [--assistant | --toggle | --tab <name>]");
                std::process::exit(0);
            }
            _ => {}
        }
    }
}

fn main() -> glib::ExitCode {
    handle_cli_args();

    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();

    // SAFETY: Called before GTK starts and before any thread is spawned.
    // Explicitly enforce the X11 backend for GDK on Linux desktop.
    unsafe { env::set_var("GDK_BACKEND", "x11") };

    let app = gtk::Application::builder()
        .application_id(APP_ID)
        .flags(gio::ApplicationFlags::NON_UNIQUE)
        .build();

    app.connect_startup(|_| {
        load_css();
    });

    app.connect_activate(|app| {
        match FloatingWindow::new(app) {
            Ok(floating) => {
                floating.present();
                ACTIVE_WINDOW.with(|cell| {
                    *cell.borrow_mut() = Some(floating);
                });
                info!("Floating notch window activated and presented");
            }
            Err(err) => {
                log::error!("Failed to create floating notch window: {err}");
                app.quit();
            }
        }
    });

    app.run()
}

/// Injects Isle's custom CSS into the GTK display provider.
fn load_css() {
    let provider = gtk::CssProvider::new();
    provider.load_from_string(include_str!("style.css"));
    gtk::style_context_add_provider_for_display(
        &gdk::Display::default().expect("GTK has no default display"),
        &provider,
        gtk::STYLE_PROVIDER_PRIORITY_USER + 1,
    );
}

