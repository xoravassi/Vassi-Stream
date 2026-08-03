@echo off
setlocal

rem Ce script compile puis execute les tests natifs du pont loopback vers node.script.
set "ROOT=%~dp0.."
set "DEV_CMD=C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\Common7\Tools\VsDevCmd.bat"
set "CMAKE=%ROOT%\.local\cmake-4.4.0-windows-x86_64\bin\cmake.exe"
set "SOURCE=%ROOT%\externals\vassi.encoder~"
set "BUILD=%ROOT%\.local\build\vassi.encoder"
set "TEST=%BUILD%\Release\vassi_frame_sender_test.exe"

if not exist "%DEV_CMD%" goto missing_compiler
if not exist "%CMAKE%" goto missing_cmake

call "%ROOT%\scripts\prepare-native-deps.cmd"
if errorlevel 1 exit /b 1

call "%DEV_CMD%" -arch=x64
if errorlevel 1 exit /b 1

"%CMAKE%" -S "%SOURCE%" -B "%BUILD%" -G "Visual Studio 17 2022" -A x64
if errorlevel 1 exit /b 1

"%CMAKE%" --build "%BUILD%" --config Release --target vassi_frame_sender_test
if errorlevel 1 exit /b 1

"%TEST%"
exit /b %ERRORLEVEL%

:missing_compiler
echo Visual Studio Build Tools C++ introuvable.
exit /b 1

:missing_cmake
echo CMake introuvable.
exit /b 1
