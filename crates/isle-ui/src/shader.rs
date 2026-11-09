// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

//! OpenGL shader pipeline executing upstream Isle Signed Distance Field (SDF) shaders.
//!
//! Direct implementation of `SHAPE_CODE` and `OUTLINE` from `gnome-extension/src/island.js`.
//! Renders the concave shoulders, bottom rounded corners, sub-pixel analytical anti-aliasing,
//! hairline edge highlights, and corner glow pools directly inside a GtkGLArea.

use glow::HasContext as _;
use log::info;

#[link(name = "GL")]
unsafe extern "C" {
    fn glXGetProcAddressARB(name: *const std::ffi::c_char) -> *const std::ffi::c_void;
}

const VERTEX_SHADER_SRC: &str = r#"#version 300 es
precision mediump float;
layout (location = 0) in vec2 a_pos;
void main() {
    gl_Position = vec4(a_pos, 0.0, 1.0);
}
"#;

const FRAGMENT_SHADER_SRC: &str = r#"#version 300 es
precision highp float;
out vec4 FragColor;

uniform vec4 u_frame;       // vec4(width, height, pixel_scale, 0.0)
uniform vec4 u_body;        // vec4(left, right, top, bottom)
uniform vec4 u_corner;      // vec4(radius, shoulder, 0.0, 0.0)
uniform vec2 u_pill;        // vec2(crown, gap)
uniform vec4 u_fill;        // vec4(r, g, b, a)
uniform vec4 u_tint;        // vec4(r, g, b, a)
uniform float u_style;      // 0.0 = none, 1.0 = wash, 2.0 = corner glow
uniform vec4 u_edge;        // vec4(r, g, b, on)
uniform vec2 u_edgeAlpha;   // vec2(top, bottom)

vec3 edgeMin(vec3 a, vec3 b) {
    return a.x < b.x ? a : b;
}

vec3 edgeMax(vec3 a, vec3 b) {
    return a.x > b.x ? a : b;
}

vec3 outlineBody(vec2 q) {
    float r = u_corner.x;
    vec2 c = vec2(
        clamp(q.x, u_body.x + r, u_body.y - r),
        clamp(q.y, u_body.z + r, u_body.w - r)
    );
    float off = length(q - c);
    if (off > 0.0)
        return vec3(r - off, (q - c) / off);
    vec3 sides = edgeMin(
        edgeMin(vec3(q.x - u_body.x, 1.0, 0.0), vec3(u_body.y - q.x, 1.0, 0.0)),
        edgeMin(vec3(q.y - u_body.z, 0.0, 1.0), vec3(u_body.w - q.y, 0.0, 1.0))
    );
    return sides;
}

// Sub-pixel analytical anti-aliased edge coverage matching Cairo rasterization
float coverage(vec3 edge, float pixel) {
    float a = max(abs(edge.y), abs(edge.z)), b = min(abs(edge.y), abs(edge.z));
    float u = edge.x * pixel, h = 0.5 * (a + b);
    if (u >= h)
        return 1.0;
    if (u <= -h)
        return 0.0;
    if (u < b - h)
        return (u + h) * (u + h) / (2.0 * a * b);
    if (u > h - b)
        return 1.0 - (h - u) * (h - u) / (2.0 * a * b);
    return (u + h - 0.5 * b) / a;
}

void main() {
    // Map OpenGL bottom-left fragment coordinates to top-down screen coordinates
    vec2 p = vec2(gl_FragCoord.x, u_frame.y - gl_FragCoord.y);
    float pixel = u_frame.z;
    float left = u_body.x, right = u_body.y, top = u_body.z, bottom = u_body.w;

    vec3 edgeAt = outlineBody(p);
    float inside = edgeAt.x;
    float cover = coverage(edgeAt, pixel);

    vec4 color = vec4(u_fill.rgb, 1.0) * u_fill.a * cover;
    vec4 tinted = vec4(u_tint.rgb, 1.0) * u_tint.a * cover;

    if (u_style > 1.5) {
        float r = max(min((right - left) * 0.36, max(0.0, bottom - top) * 1.05), 0.001);
        float a = 0.2 * clamp((p.y - bottom + 0.4 * r) / (0.4 * r), 0.0, 1.0);
        color = tinted * a + color * (1.0 - tinted.a * a);
        for (int i = 0; i < 2; i++) {
            float t = length(p - vec2(i == 0 ? left + 0.12 * r : right - 0.12 * r, bottom + 0.2 * r)) / r;
            a = t < 0.4 ? mix(0.95, 0.42, t / 0.4) : mix(0.42, 0.0, min(1.0, (t - 0.4) / 0.6));
            color = tinted * a + color * (1.0 - tinted.a * a);
        }
    } else if (u_style > 0.5) {
        float a = 0.75 * clamp((p.y - top) / max(bottom - top, 0.001), 0.0, 1.0);
        color = tinted * a + color * (1.0 - tinted.a * a);
    }

    if (u_edge.a > 0.0) {
        // Slim, clean 1px border uniformly distributed along the entire rounded perimeter
        float band = max(0.0, min(inside + 0.5 / pixel, 1.0) - max(inside - 0.5 / pixel, 0.0)) * pixel;
        float a = u_edgeAlpha.x * band;
        color = vec4(u_edge.rgb, 1.0) * a + color * (1.0 - a);
    }

    FragColor = color;
}
"#;

const QUAD_VERTICES: [f32; 8] = [
    -1.0, -1.0,
     1.0, -1.0,
    -1.0,  1.0,
     1.0,  1.0,
];

pub struct ShaderPipeline {
    gl: glow::Context,
    program: glow::Program,
    vao: glow::VertexArray,
    _vbo: glow::Buffer,
    loc_frame: Option<glow::UniformLocation>,
    loc_body: Option<glow::UniformLocation>,
    loc_corner: Option<glow::UniformLocation>,
    loc_pill: Option<glow::UniformLocation>,
    loc_fill: Option<glow::UniformLocation>,
    loc_tint: Option<glow::UniformLocation>,
    loc_style: Option<glow::UniformLocation>,
    loc_edge: Option<glow::UniformLocation>,
    loc_edge_alpha: Option<glow::UniformLocation>,
}

impl ShaderPipeline {
    pub fn new() -> Result<Self, String> {
        let gl = unsafe {
            glow::Context::from_loader_function(|name| {
                let c_str = std::ffi::CString::new(name).unwrap();
                glXGetProcAddressARB(c_str.as_ptr())
            })
        };

        unsafe {
            let program = gl.create_program().map_err(|e| format!("GL create program error: {e}"))?;

            let vs = gl.create_shader(glow::VERTEX_SHADER).map_err(|e| e.to_string())?;
            gl.shader_source(vs, VERTEX_SHADER_SRC);
            gl.compile_shader(vs);
            if !gl.get_shader_compile_status(vs) {
                let log = gl.get_shader_info_log(vs);
                return Err(format!("Vertex shader error: {log}"));
            }

            let fs = gl.create_shader(glow::FRAGMENT_SHADER).map_err(|e| e.to_string())?;
            gl.shader_source(fs, FRAGMENT_SHADER_SRC);
            gl.compile_shader(fs);
            if !gl.get_shader_compile_status(fs) {
                let log = gl.get_shader_info_log(fs);
                return Err(format!("Fragment shader error: {log}"));
            }

            gl.attach_shader(program, vs);
            gl.attach_shader(program, fs);
            gl.link_program(program);
            if !gl.get_program_link_status(program) {
                let log = gl.get_program_info_log(program);
                return Err(format!("Program link error: {log}"));
            }

            gl.delete_shader(vs);
            gl.delete_shader(fs);

            let vao = gl.create_vertex_array().map_err(|e| e.to_string())?;
            let vbo = gl.create_buffer().map_err(|e| e.to_string())?;

            gl.bind_vertex_array(Some(vao));
            gl.bind_buffer(glow::ARRAY_BUFFER, Some(vbo));
            gl.buffer_data_u8_slice(
                glow::ARRAY_BUFFER,
                bytemuck_cast_slice(&QUAD_VERTICES),
                glow::STATIC_DRAW,
            );

            gl.enable_vertex_attrib_array(0);
            gl.vertex_attrib_pointer_f32(0, 2, glow::FLOAT, false, 2 * 4, 0);

            gl.bind_buffer(glow::ARRAY_BUFFER, None);
            gl.bind_vertex_array(None);

            let loc_frame = gl.get_uniform_location(program, "u_frame");
            let loc_body = gl.get_uniform_location(program, "u_body");
            let loc_corner = gl.get_uniform_location(program, "u_corner");
            let loc_pill = gl.get_uniform_location(program, "u_pill");
            let loc_fill = gl.get_uniform_location(program, "u_fill");
            let loc_tint = gl.get_uniform_location(program, "u_tint");
            let loc_style = gl.get_uniform_location(program, "u_style");
            let loc_edge = gl.get_uniform_location(program, "u_edge");
            let loc_edge_alpha = gl.get_uniform_location(program, "u_edgeAlpha");

            info!("Compiled and linked Isle SDF shader pipeline successfully");

            Ok(Self {
                gl,
                program,
                vao,
                _vbo: vbo,
                loc_frame,
                loc_body,
                loc_corner,
                loc_pill,
                loc_fill,
                loc_tint,
                loc_style,
                loc_edge,
                loc_edge_alpha,
            })
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub fn render(
        &self,
        viewport_w: i32,
        viewport_h: i32,
        scale: f32,
        body_left: f32,
        body_right: f32,
        body_top: f32,
        body_bottom: f32,
        radius: f32,
        shoulder: f32,
        pill_crown: f32,
        pill_gap: f32,
        fill_rgba: [f32; 4],
        tint_rgba: [f32; 4],
        tint_style: f32,
        edge_rgba: [f32; 4],
        edge_alpha: [f32; 2],
    ) {
        unsafe {
            let gl = &self.gl;
            gl.viewport(0, 0, viewport_w, viewport_h);
            gl.clear_color(0.0, 0.0, 0.0, 0.0);
            gl.clear(glow::COLOR_BUFFER_BIT);

            gl.enable(glow::BLEND);
            gl.blend_func(glow::ONE, glow::ONE_MINUS_SRC_ALPHA);

            gl.use_program(Some(self.program));

            if let Some(ref loc) = self.loc_frame {
                gl.uniform_4_f32(Some(loc), viewport_w as f32, viewport_h as f32, scale, 0.0);
            }
            if let Some(ref loc) = self.loc_body {
                gl.uniform_4_f32(Some(loc), body_left, body_right, body_top, body_bottom);
            }
            if let Some(ref loc) = self.loc_corner {
                gl.uniform_4_f32(Some(loc), radius, shoulder, 0.0, 0.0);
            }
            if let Some(ref loc) = self.loc_pill {
                gl.uniform_2_f32(Some(loc), pill_crown, pill_gap);
            }
            if let Some(ref loc) = self.loc_fill {
                gl.uniform_4_f32(
                    Some(loc),
                    fill_rgba[0],
                    fill_rgba[1],
                    fill_rgba[2],
                    fill_rgba[3],
                );
            }
            if let Some(ref loc) = self.loc_tint {
                gl.uniform_4_f32(
                    Some(loc),
                    tint_rgba[0],
                    tint_rgba[1],
                    tint_rgba[2],
                    tint_rgba[3],
                );
            }
            if let Some(ref loc) = self.loc_style {
                gl.uniform_1_f32(Some(loc), tint_style);
            }
            if let Some(ref loc) = self.loc_edge {
                gl.uniform_4_f32(
                    Some(loc),
                    edge_rgba[0],
                    edge_rgba[1],
                    edge_rgba[2],
                    edge_rgba[3],
                );
            }
            if let Some(ref loc) = self.loc_edge_alpha {
                gl.uniform_2_f32(Some(loc), edge_alpha[0], edge_alpha[1]);
            }

            gl.bind_vertex_array(Some(self.vao));
            gl.draw_arrays(glow::TRIANGLE_STRIP, 0, 4);
            gl.bind_vertex_array(None);
            gl.use_program(None);
        }
    }
}

fn bytemuck_cast_slice(floats: &[f32]) -> &[u8] {
    unsafe {
        std::slice::from_raw_parts(
            floats.as_ptr() as *const u8,
            floats.len() * std::mem::size_of::<f32>(),
        )
    }
}
