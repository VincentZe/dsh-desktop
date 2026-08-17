cmake_minimum_required(VERSION 3.21)
project(dsh-desktop VERSION 0.1.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# The generic Win32 + WebView2 shell framework lives in its own project.
set(LUNA_UI_DIR "" CACHE PATH
    "Path to the luna_ui framework CMake project")
set(WEBVIEW2_ROOT "" CACHE PATH
    "Directory containing WebView2 include/, lib/, and bin/")

if(NOT LUNA_UI_DIR OR NOT EXISTS "${LUNA_UI_DIR}/CMakeLists.txt")
    message(FATAL_ERROR
        "luna_ui framework not found; "
        "configure with -DLUNA_UI_DIR=<path>")
endif()
if(NOT WEBVIEW2_ROOT OR NOT EXISTS "${WEBVIEW2_ROOT}")
    message(FATAL_ERROR
        "WebView2 SDK not found; configure with -DWEBVIEW2_ROOT=<path>")
endif()
set(LUNA_UI_BUILD_EXAMPLE OFF CACHE BOOL
    "Build the LunaUI example app" FORCE)
add_subdirectory("${LUNA_UI_DIR}" luna_ui)

add_executable(dsh-desktop WIN32
    src/app.rc
    src/resource.h
    src/main.cpp
    src/config.cpp
    src/config.hpp
    src/backend.cpp
    src/backend.hpp
    src/json.cpp
    src/json.hpp
)

set_target_properties(dsh-desktop PROPERTIES
    VS_DPI_AWARE "PerMonitor"
)

target_compile_definitions(dsh-desktop PRIVATE
    NOMINMAX
    UNICODE
    _UNICODE
)
target_include_directories(dsh-desktop PRIVATE
    "${CMAKE_CURRENT_SOURCE_DIR}/src"
)
target_link_libraries(dsh-desktop PRIVATE
    luna_ui
    luna_ui_window_manager
    user32
    ole32
    shell32
)

if(MSVC)
    target_compile_options(dsh-desktop PRIVATE /W4 /permissive- /utf-8)
endif()

# Copy the runtime loader next to the exe so the built output is runnable in
# place. config.json is intentionally NOT copied: the compiled defaults match
# the shipped file, and a copy next to the exe would be clobbered on rebuild.
add_custom_command(TARGET dsh-desktop POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E copy_if_different
        "${WEBVIEW2_ROOT}/bin/WebView2Loader.dll"
        "$<TARGET_FILE_DIR:dsh-desktop>"
)
