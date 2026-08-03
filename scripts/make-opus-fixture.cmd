@echo off
setlocal

rem Ce script produit la fixture Opus lue par les tests du player et par la page de test navigateur.
rem Il passe par l'encodeur reel du device : la fixture contient ce qu'un vrai live transmet.
set "ROOT=%~dp0.."
set "DEV_CMD=C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\Common7\Tools\VsDevCmd.bat"
set "CMAKE=%ROOT%\.local\cmake-4.4.0-windows-x86_64\bin\cmake.exe"
set "SOURCE=%ROOT%\externals\vassi.encoder~"
set "BUILD=%ROOT%\.local\build\vassi.encoder"
set "TOOL=%BUILD%\Release\vassi_make_opus_fixture.exe"
set "INPUT=%ROOT%\assets\audio\vassi-stereo-test-48k-24bit.wav"
set "OUTPUT=%ROOT%\tests\fixtures\stereo-440-880-256k.vsa1"

if not exist "%DEV_CMD%" goto missing_compiler
if not exist "%CMAKE%" goto missing_cmake

call "%ROOT%\scripts\prepare-native-deps.cmd"
if errorlevel 1 exit /b 1

call "%DEV_CMD%" -arch=x64
if errorlevel 1 exit /b 1

"%CMAKE%" -S "%SOURCE%" -B "%BUILD%" -G "Visual Studio 17 2022" -A x64
if errorlevel 1 exit /b 1

"%CMAKE%" --build "%BUILD%" --config Release --target vassi_make_opus_fixture
if errorlevel 1 exit /b 1

if not exist "%ROOT%\tests\fixtures" mkdir "%ROOT%\tests\fixtures"

"%TOOL%" "%INPUT%" "%OUTPUT%" 256000
exit /b %ERRORLEVEL%

:missing_compiler
echo Visual Studio Build Tools C++ introuvable.
exit /b 1

:missing_cmake
echo CMake introuvable.
exit /b 1
