@echo off
setlocal

rem Ce script compile puis execute les tests natifs de la queue audio sur Windows x64.
set "ROOT=%~dp0.."
set "DEV_CMD=C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\Common7\Tools\VsDevCmd.bat"
set "SOURCE=%ROOT%\externals\vassi.encoder~\source"
set "TEST=%ROOT%\tests\native\audio_queue.test.cpp"
set "OUTPUT=%ROOT%\.local\native-tests"

if not exist "%DEV_CMD%" goto missing_compiler
if not exist "%OUTPUT%" mkdir "%OUTPUT%"

call "%DEV_CMD%" -arch=x64
if errorlevel 1 exit /b 1

pushd "%OUTPUT%"
cl.exe /nologo /std:c++17 /EHsc /O2 /W4 /WX /I"%SOURCE%" "%TEST%" "%SOURCE%\audio_queue.cpp" /Fe:"audio_queue.test.exe"
if errorlevel 1 goto compile_failed

rem Le chemin reste explicite : le repertoire courant n'est pas toujours dans le chemin de recherche.
"%OUTPUT%\audio_queue.test.exe"
set "TEST_ERROR=%ERRORLEVEL%"
popd
exit /b %TEST_ERROR%

:compile_failed
popd
exit /b 1

:missing_compiler
echo Visual Studio Build Tools C++ introuvable.
exit /b 1
