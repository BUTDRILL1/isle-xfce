// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

//! Floating Notch window with upstream Isle SDF shader rendering and spring physics.

use std::cell::{Cell, RefCell};
use std::rc::Rc;
use std::time::Instant;

use gtk::glib;
use gtk::prelude::*;
use gtk4 as gtk;
use log::{error, info};
use x11rb::protocol::xproto::Window;

use crate::runtime::GjsRuntime;
use crate::shader::ShaderPipeline;
use crate::spring::{GENTLE_CONFIG, ISLAND_CONFIG, Spring};
use crate::x11::{get_x11_window, sync_gdk, Error, X11Context};

/// Compact (resting) proportions for clean floating glass panel:
/// - Resting panel: width 240px, depth 38px, rounded corners 18px, shoulder 0px.
pub const COMPACT_WIDTH: f64 = 240.0;
pub const COMPACT_HEIGHT: f64 = 38.0;
pub const COMPACT_RADIUS: f64 = 18.0;
pub const COMPACT_SHOULDER: f64 = 0.0;

/// Standard expanded proportions for media, timer, usage (600 × 300 px):
pub const STANDARD_EXPANDED_WIDTH: f64 = 600.0;
pub const STANDARD_EXPANDED_HEIGHT: f64 = 300.0;

/// Dedicated expanded proportions for Assistant conversation (640 × 380 px):
pub const ASSISTANT_EXPANDED_WIDTH: f64 = 640.0;
pub const ASSISTANT_EXPANDED_HEIGHT: f64 = 380.0;

#[allow(dead_code)]
pub const EXPANDED_WIDTH: f64 = STANDARD_EXPANDED_WIDTH;
#[allow(dead_code)]
pub const EXPANDED_HEIGHT: f64 = STANDARD_EXPANDED_HEIGHT;
pub const EXPANDED_RADIUS: f64 = 24.0;
pub const EXPANDED_SHOULDER: f64 = 0.0;

/// Translucent dark fill matching upstream theme.js for Picom dual-kawase blur.
const FILL_RGBA: [f32; 4] = [0.03, 0.04, 0.05, 0.40];
const EDGE_RGBA: [f32; 4] = [1.0, 1.0, 1.0, 1.0];
const EDGE_ALPHA: [f32; 2] = [0.15, 0.15];

/// Manages the floating notch GTK4 window, shader pipeline, and spring animations.
#[derive(Clone)]
pub struct FloatingWindow(Rc<Inner>);

struct Inner {
    window: gtk::Window,
    gl_area: gtk::GLArea,
    x11: X11Context,
    xid: Cell<Option<Window>>,
    pipeline: RefCell<Option<ShaderPipeline>>,
    gjs: Option<GjsRuntime>,
    // 4 Harmonic Springs driving geometry morphing
    width_spring: Cell<Spring>,
    height_spring: Cell<Spring>,
    radius_spring: Cell<Spring>,
    shoulder_spring: Cell<Spring>,
    is_expanded: Cell<bool>,
    animating: Cell<bool>,
    last_tick: Cell<Option<Instant>>,

    // Pointer Tracking & Debounce State
    is_hovered: Cell<bool>,
    last_pointer_pos: Cell<(f64, f64)>,
    manual_collapse_screen_pos: Cell<Option<(f64, f64)>>,
    collapse_timer: Cell<Option<glib::SourceId>>,

    // X11 Keyboard Focus Management
    previous_focus: Cell<Option<Window>>,
}

impl FloatingWindow {
    pub fn new(app: &gtk::Application) -> Result<Self, Error> {
        let x11 = X11Context::new()?;

        let window = gtk::Window::builder()
            .application(app)
            .title("Isle Floating Notch")
            .decorated(false)
            .resizable(false)
            .css_classes(["isle-window"])
            .build();

        // Calculate initial resting outer dimensions
        let initial_outer_w = (COMPACT_WIDTH + 2.0 * COMPACT_SHOULDER).ceil() as i32;
        let initial_h = COMPACT_HEIGHT.ceil() as i32;
        window.set_default_size(initial_outer_w, initial_h);
        window.set_size_request(initial_outer_w, initial_h);

        let overlay = gtk::Overlay::builder()
            .hexpand(true)
            .vexpand(true)
            .css_classes(["isle-overlay"])
            .build();

        let gl_area = gtk::GLArea::builder()
            .has_depth_buffer(false)
            .has_stencil_buffer(false)
            .auto_render(true)
            .hexpand(true)
            .vexpand(true)
            .build();
        overlay.set_child(Some(&gl_area));
        window.set_child(Some(&overlay));

        let gjs = GjsRuntime::new();

        let inner = Rc::new(Inner {
            window,
            gl_area: gl_area.clone(),
            x11,
            xid: Cell::new(None),
            pipeline: RefCell::new(None),
            gjs,
            width_spring: Cell::new(Spring::new(COMPACT_WIDTH, ISLAND_CONFIG)),
            height_spring: Cell::new(Spring::new(COMPACT_HEIGHT, ISLAND_CONFIG)),
            radius_spring: Cell::new(Spring::new(COMPACT_RADIUS, GENTLE_CONFIG)),
            shoulder_spring: Cell::new(Spring::new(COMPACT_SHOULDER, GENTLE_CONFIG)),
            is_expanded: Cell::new(false),
            animating: Cell::new(false),
            last_tick: Cell::new(None),
            is_hovered: Cell::new(false),
            last_pointer_pos: Cell::new((0.0, 0.0)),
            manual_collapse_screen_pos: Cell::new(None),
            collapse_timer: Cell::new(None),
            previous_focus: Cell::new(None),
        });

        let floating = Self(inner);

        // 1. GtkGLArea realize: compile OpenGL shader pipeline
        let weak_gl_realize = Rc::downgrade(&floating.0);
        gl_area.connect_realize(move |area| {
            let Some(inner) = weak_gl_realize.upgrade() else { return };
            area.make_current();
            match ShaderPipeline::new() {
                Ok(pipe) => {
                    *inner.pipeline.borrow_mut() = Some(pipe);
                    info!("GtkGLArea initialized and compiled SDF shader pipeline");
                }
                Err(err) => {
                    error!("Shader initialization failed: {err}");
                }
            }
        });

        // 2. GtkGLArea render: evaluate SDF geometry each frame
        let weak_gl_render = Rc::downgrade(&floating.0);
        gl_area.connect_render(move |area, _ctx| {
            let Some(inner) = weak_gl_render.upgrade() else {
                return glib::Propagation::Proceed;
            };

            let pipeline = inner.pipeline.borrow();
            let Some(ref pipe) = *pipeline else {
                return glib::Propagation::Proceed;
            };

            let width = area.width() as f32;
            let height = area.height() as f32;
            let scale = area.scale_factor() as f32;

            let w_val = inner.width_spring.get().value as f32;
            let h_val = inner.height_spring.get().value as f32;
            let r_val = inner.radius_spring.get().value as f32;
            let sh_val = inner.shoulder_spring.get().value as f32;

            let body_left = ((width - w_val) / 2.0) * scale;
            let body_right = body_left + w_val * scale;
            let body_top = 0.0f32;
            let body_bottom = h_val * scale;

            pipe.render(
                (width * scale).ceil() as i32,
                (height * scale).ceil() as i32,
                scale,
                body_left,
                body_right,
                body_top,
                body_bottom,
                r_val * scale,
                sh_val * scale,
                0.0,
                0.0,
                FILL_RGBA,
                [0.27, 0.56, 1.0, 0.0],
                0.0,
                EDGE_RGBA,
                EDGE_ALPHA,
            );

            glib::Propagation::Stop
        });

        // 3. Motion controller: expand on hover enter, collapse on hover leave
        let motion = gtk::EventControllerMotion::new();
        motion.set_propagation_phase(gtk::PropagationPhase::Capture);

        let weak_enter = Rc::downgrade(&floating.0);
        motion.connect_enter(move |_, x, y| {
            let Some(inner) = weak_enter.upgrade() else { return };
            let geom = FloatingWindow(inner.clone()).current_geometry();
            let (cur_w, cur_h, _, _) = geom;
            let (sx, sy) = widget_to_screen(&inner.window, geom, x, y);
            let is_expanded = inner.is_expanded.get();
            let is_animating = inner.animating.get();

            info!(
                "[POINTER] Enter at widget ({x:.1}, {y:.1}) [screen ({sx:.1}, {sy:.1})] | window_geom=({cur_w:.1}x{cur_h:.1}), expanded={is_expanded}, animating={is_animating}"
            );

            inner.is_hovered.set(true);
            inner.last_pointer_pos.set((x, y));

            // Cancel any pending collapse debounce timer
            if let Some(id) = inner.collapse_timer.take() {
                id.remove();
                info!("[POINTER] Cancelled pending collapse timer on re-entry");
            }

            // Check if suppressed by manual collapse anchor
            if let Some((ax, ay)) = inner.manual_collapse_screen_pos.get() {
                let dist = (sx - ax).hypot(sy - ay);
                if dist < 20.0 {
                    info!(
                        "[POINTER] Suppressed expand transition: stationary pointer at screen ({sx:.1}, {sy:.1}) matches manual collapse anchor ({ax:.1}, {ay:.1}) (dist={dist:.1} < 20px)"
                    );
                    return;
                } else {
                    info!(
                        "[POINTER] Pointer moved {dist:.1}px on screen away from manual collapse anchor ({ax:.1}, {ay:.1}); clearing anchor"
                    );
                    inner.manual_collapse_screen_pos.set(None);
                }
            }

            // If the window is currently collapsing, suppress re-expansion if the pointer is outside compact notch height
            if !is_expanded && is_animating && sy > COMPACT_HEIGHT {
                info!(
                    "[POINTER] Suppressed expand transition: pointer at screen Y={sy:.1} is outside compact notch height ({COMPACT_HEIGHT}) while collapsing"
                );
                return;
            }

            if !is_expanded {
                let floating = FloatingWindow(inner);
                floating.set_expanded(true, "pointer-enter");
            }
        });

        let weak_motion = Rc::downgrade(&floating.0);
        motion.connect_motion(move |_, x, y| {
            let Some(inner) = weak_motion.upgrade() else { return };
            let geom = FloatingWindow(inner.clone()).current_geometry();
            let (sx, sy) = widget_to_screen(&inner.window, geom, x, y);

            inner.is_hovered.set(true);
            inner.last_pointer_pos.set((x, y));

            // Cancel any pending collapse timer
            if let Some(id) = inner.collapse_timer.take() {
                id.remove();
                info!("[POINTER] Cancelled pending collapse timer on motion");
            }

            // Check manual collapse anchor
            if let Some((ax, ay)) = inner.manual_collapse_screen_pos.get() {
                let dist = (sx - ax).hypot(sy - ay);
                if dist > 20.0 {
                    info!(
                        "[POINTER] Pointer moved {dist:.1}px on screen away from manual collapse anchor; clearing anchor"
                    );
                    inner.manual_collapse_screen_pos.set(None);
                    if !inner.is_expanded.get() && sy <= COMPACT_HEIGHT {
                        let floating = FloatingWindow(inner);
                        floating.set_expanded(true, "pointer-motion-after-anchor-cleared");
                    }
                }
            } else if !inner.is_expanded.get() && (!inner.animating.get() || sy <= COMPACT_HEIGHT) {
                let floating = FloatingWindow(inner);
                floating.set_expanded(true, "pointer-motion");
            }
        });

        let weak_leave = Rc::downgrade(&floating.0);
        let motion_leave_clone = motion.clone();
        motion.connect_leave(move |_| {
            let Some(inner) = weak_leave.upgrade() else { return };
            let (lx, ly) = inner.last_pointer_pos.get();
            let geom = FloatingWindow(inner.clone()).current_geometry();
            let (cur_w, cur_h, _, _) = geom;
            let (lsx, lsy) = widget_to_screen(&inner.window, geom, lx, ly);
            let is_expanded = inner.is_expanded.get();
            let is_animating = inner.animating.get();

            info!(
                "[POINTER] Leave signal received | last_screen_pos=({lsx:.1}, {lsy:.1}), window_geom=({cur_w:.1}x{cur_h:.1}), expanded={is_expanded}, animating={is_animating}"
            );

            inner.is_hovered.set(false);
            // Leaving the window surface clears any manual collapse anchor
            inner.manual_collapse_screen_pos.set(None);

            // Cancel any existing collapse timer
            if let Some(id) = inner.collapse_timer.take() {
                id.remove();
            }

            // Start well-defined debounce check (120ms, matching upstream Isle's collapse delay)
            let wl = weak_leave.clone();
            let ctrl = motion_leave_clone.clone();
            let timer_id = glib::timeout_add_local_once(std::time::Duration::from_millis(120), move || {
                let Some(inner) = wl.upgrade() else { return };
                inner.collapse_timer.set(None);

                let contains = ctrl.contains_pointer();
                let is_hovered = inner.is_hovered.get();
                let is_expanded = inner.is_expanded.get();
                let (w_val, h_val, _, _) = FloatingWindow(inner.clone()).current_geometry();

                info!(
                    "[POINTER] Debounce check (120ms): contains_pointer={contains}, is_hovered={is_hovered}, is_expanded={is_expanded}, geom=({w_val:.1}x{h_val:.1})"
                );

                if !contains && !is_hovered {
                    if is_expanded {
                        info!("[POINTER] Pointer confirmed outside window; triggering collapse to COMPACT");
                        let floating = FloatingWindow(inner);
                        floating.set_expanded(false, "hover-leave");
                    } else {
                        info!("[POINTER] Suppressed collapse: already in compact target state");
                    }
                } else {
                    info!(
                        "[POINTER] Suppressed collapse: pointer re-entered or still contained (contains={contains}, is_hovered={is_hovered})"
                    );
                }
            });
            inner.collapse_timer.set(Some(timer_id));
        });

        floating.0.window.add_controller(motion);

        // Click gesture to expand when clicked in compact state.
        // Background clicks while expanded do not collapse the panel.
        let click = gtk::GestureClick::new();
        let weak_click = Rc::downgrade(&floating.0);
        click.connect_released(move |_, _, x, y| {
            let Some(inner) = weak_click.upgrade() else { return };
            let is_exp = inner.is_expanded.get();
            let geom = FloatingWindow(inner.clone()).current_geometry();
            let (cur_w, cur_h, _, _) = geom;
            let (sx, sy) = widget_to_screen(&inner.window, geom, x, y);
            let floating = FloatingWindow(inner.clone());

            if !is_exp {
                info!(
                    "[INTERACTION] Click received at screen ({sx:.1}, {sy:.1}) [widget ({x:.1}, {y:.1})] on compact notch ({cur_w:.1}x{cur_h:.1}); expanding"
                );
                inner.manual_collapse_screen_pos.set(None);
                floating.set_expanded(true, "click-expand");
            } else {
                // When clicking inside the expanded notch, ensure X11 input focus is active
                if let Some(xid) = inner.xid.get() {
                    let _ = inner.x11.focus_window(xid);
                }
            }
        });
        overlay.add_controller(click);

        // 4. Window lifecycle: realize X11 override-redirect before mapping
        let weak_realize = Rc::downgrade(&floating.0);
        floating.0.window.connect_realize(move |window| {
            let Some(inner) = weak_realize.upgrade() else { return };
            sync_gdk(window);
            let Some(xid) = get_x11_window(window) else {
                error!("Failed to obtain X11 Window ID on realize");
                return;
            };

            if let Err(err) = inner.x11.set_override_redirect(xid, true) {
                error!("Failed to configure override_redirect on XID {xid:#x}: {err}");
            } else {
                info!("X11 surface realized: XID {xid:#x}, override-redirect set");
                inner.xid.set(Some(xid));
            }
        });

        let weak_unrealize = Rc::downgrade(&floating.0);
        floating.0.window.connect_unrealize(move |_| {
            if let Some(inner) = weak_unrealize.upgrade() {
                inner.xid.set(None);
            }
        });

        let weak_map = Rc::downgrade(&floating.0);
        floating.0.window.connect_map(move |_| {
            if let Some(inner) = weak_map.upgrade() {
                let floating = FloatingWindow(inner);
                glib::idle_add_local_once(move || {
                    floating.sync_x11_bounds();
                });
            }
        });

        // 5. Connect css-classes notification to update geometry dynamically when switching modes
        let weak_css = Rc::downgrade(&floating.0);
        floating.0.window.connect_css_classes_notify(move |win| {
            if let Some(inner) = weak_css.upgrade() {
                let is_asst = win.has_css_class("isle-mode-assistant");
                info!("[MODE] Window css-classes changed: isle-mode-assistant={is_asst}");
                let floating = FloatingWindow(inner);
                floating.update_target_geometry("css-classes-changed");
            }
        });

        Ok(floating)
    }

    /// Returns current spring values (width, height, radius, shoulder).
    pub fn current_geometry(&self) -> (f64, f64, f64, f64) {
        let w = self.0.width_spring.get().value;
        let h = self.0.height_spring.get().value;
        let r = self.0.radius_spring.get().value;
        let sh = self.0.shoulder_spring.get().value;
        (w, h, r, sh)
    }

    /// Sets the target state: Compact (resting) or Expanded with an explicit reason.
    pub fn set_expanded(&self, expanded: bool, reason: &str) {
        if self.0.is_expanded.get() == expanded {
            return;
        }

        self.0.is_expanded.set(expanded);

        if expanded {
            // Save current X11 focus window before assigning focus to Isle
            if let Some(xid) = self.0.xid.get() {
                if let Ok(prev) = self.0.x11.get_input_focus() {
                    // Do not store Isle itself as the previous focus window
                    if prev != xid && prev != 0 && prev != 1 {
                        self.0.previous_focus.set(Some(prev));
                    }
                }
                let _ = self.0.x11.focus_window(xid);
            }
        } else {
            // Restore previous X11 focus window when collapsing
            let prev = self.0.previous_focus.take();
            let _ = self.0.x11.restore_focus(prev);
        }

        self.update_target_geometry(reason);
    }

    /// Updates the spring targets dynamically based on current expansion state and active mode.
    /// Preserves smooth continuous spring physics and prevents visual hitches or resets.
    pub fn update_target_geometry(&self, reason: &str) {
        let is_expanded = self.0.is_expanded.get();
        let is_asst = self.0.window.has_css_class("isle-mode-assistant");
        let (cur_w, cur_h, _, _) = self.current_geometry();

        let (target_w, target_h, target_r, target_sh) = if is_expanded {
            if is_asst {
                (
                    ASSISTANT_EXPANDED_WIDTH,
                    ASSISTANT_EXPANDED_HEIGHT,
                    EXPANDED_RADIUS,
                    EXPANDED_SHOULDER,
                )
            } else {
                (
                    STANDARD_EXPANDED_WIDTH,
                    STANDARD_EXPANDED_HEIGHT,
                    EXPANDED_RADIUS,
                    EXPANDED_SHOULDER,
                )
            }
        } else {
            (COMPACT_WIDTH, COMPACT_HEIGHT, COMPACT_RADIUS, COMPACT_SHOULDER)
        };

        let mut w = self.0.width_spring.get();
        let mut h = self.0.height_spring.get();
        let mut r = self.0.radius_spring.get();
        let mut sh = self.0.shoulder_spring.get();

        if (w.target - target_w).abs() > 0.1 || (h.target - target_h).abs() > 0.1 {
            let is_animating = self.0.animating.get();
            info!(
                "[GEOMETRY] Retarget springs (reason: {reason}) | current=({cur_w:.1}x{cur_h:.1}), target=({target_w:.1}x{target_h:.1}), animating={is_animating}, expanded={is_expanded}, asst={is_asst}"
            );

            w.set_target(target_w);
            h.set_target(target_h);
            r.set_target(target_r);
            sh.set_target(target_sh);

            self.0.width_spring.set(w);
            self.0.height_spring.set(h);
            self.0.radius_spring.set(r);
            self.0.shoulder_spring.set(sh);

            self.start_animation();
        }
    }

    /// Starts stepping the 4 springs on Gtk tick callbacks.
    fn start_animation(&self) {
        if self.0.animating.get() {
            return;
        }
        self.0.animating.set(true);
        self.0.last_tick.set(Some(Instant::now()));

        let weak = Rc::downgrade(&self.0);
        self.0.window.add_tick_callback(move |_, _| {
            let Some(inner) = weak.upgrade() else {
                return glib::ControlFlow::Break;
            };

            let now = Instant::now();
            let last = inner.last_tick.get().unwrap_or(now);
            let dt = (now - last).as_secs_f64();
            inner.last_tick.set(Some(now));

            let mut w = inner.width_spring.get();
            let mut h = inner.height_spring.get();
            let mut r = inner.radius_spring.get();
            let mut sh = inner.shoulder_spring.get();

            // Verify and adapt spring targets if mode changed mid-animation
            let is_expanded = inner.is_expanded.get();
            if is_expanded {
                let is_asst = inner.window.has_css_class("isle-mode-assistant");
                let target_w = if is_asst { ASSISTANT_EXPANDED_WIDTH } else { STANDARD_EXPANDED_WIDTH };
                let target_h = if is_asst { ASSISTANT_EXPANDED_HEIGHT } else { STANDARD_EXPANDED_HEIGHT };
                if (w.target - target_w).abs() > 0.1 || (h.target - target_h).abs() > 0.1 {
                    w.set_target(target_w);
                    h.set_target(target_h);
                }
            }

            let s1 = w.step(dt);
            let s2 = h.step(dt);
            let s3 = r.step(dt);
            let s4 = sh.step(dt);

            inner.width_spring.set(w);
            inner.height_spring.set(h);
            inner.radius_spring.set(r);
            inner.shoulder_spring.set(sh);

            let floating = FloatingWindow(inner.clone());
            floating.sync_x11_bounds();
            inner.gl_area.queue_render();

            if s1 && s2 && s3 && s4 {
                inner.animating.set(false);
                inner.last_tick.set(None);
                let target_str = if inner.is_expanded.get() {
                    if inner.window.has_css_class("isle-mode-assistant") {
                        "ASSISTANT_EXPANDED (640x380)"
                    } else {
                        "STANDARD_EXPANDED (600x300)"
                    }
                } else {
                    "COMPACT (240x38)"
                };
                info!(
                    "[ANIMATION] Spring settled at ({:.1}x{:.1}) | target={target_str}",
                    w.value, h.value
                );
                glib::ControlFlow::Break
            } else {
                glib::ControlFlow::Continue
            }
        });
    }

    /// Synchronizes X11 override-redirect window placement with the current spring bounds.
    pub fn sync_x11_bounds(&self) {
        let Some(xid) = self.0.xid.get() else {
            return;
        };

        let w_val = self.0.width_spring.get().value;
        let h_val = self.0.height_spring.get().value;
        let sh_val = self.0.shoulder_spring.get().value;

        // Total outer width includes the concave shoulders on both sides
        let outer_w = (w_val + 2.0 * sh_val).ceil().max(COMPACT_WIDTH) as u32;
        let height = h_val.ceil().max(COMPACT_HEIGHT) as u32;

        let (screen_w, _) = screen_size(&self.0.window);
        let x = (screen_w - outer_w as i32) / 2;
        let y = 0; // Top of the screen

        let scale = self.0.window.scale_factor();

        self.0.window.set_size_request(outer_w as i32, height as i32);

        sync_gdk(&self.0.window);
        let _ = self.0.x11.configure_geometry(
            xid,
            x * scale,
            y * scale,
            outer_w * scale as u32,
            height * scale as u32,
        );
        let _ = self.0.x11.restack_above(xid);
    }

    pub fn present(&self) {
        self.0.window.present();
        if let Some(ref gjs) = self.0.gjs {
            if let Err(err) = gjs.eval_module_file("/home/butarch/Desktop/isle-xfce/ui/main.js") {
                log::error!("Failed to evaluate Isle GJS frontend: {err}");
            } else {
                info!("Isle GJS frontend successfully evaluated and mounted");
            }
        }
    }
}

fn screen_size(window: &gtk::Window) -> (i32, i32) {
    if let Some(display) = WidgetExt::display(window).downcast_ref::<gdk4_x11::X11Display>() {
        let monitors = display.monitors();
        if let Some(monitor) = monitors.item(0).and_then(|m| m.downcast::<gtk::gdk::Monitor>().ok()) {
            let geom = monitor.geometry();
            return (geom.width(), geom.height());
        }
    }
    (1920, 1080)
}

fn widget_to_screen(window: &gtk::Window, geom: (f64, f64, f64, f64), wx: f64, wy: f64) -> (f64, f64) {
    let (cur_w, _, _, cur_sh) = geom;
    let outer_w = (cur_w + 2.0 * cur_sh).ceil();
    let (screen_w, _) = screen_size(window);
    let win_x = (screen_w - outer_w as i32) as f64 / 2.0;
    (win_x + wx, wy)
}

