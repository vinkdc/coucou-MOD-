// Kotoba runs without a console window.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    kotoba_lib::run()
}
