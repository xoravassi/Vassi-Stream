@echo off
setlocal

rem Ce script telecharge une seule fois les versions natives exactes utilisees par le projet.
set "ROOT=%~dp0.."
set "DEPS=%ROOT%\.local\deps"

if not exist "%DEPS%" mkdir "%DEPS%"

call :ensure_repo "opus-1.5.2" "https://github.com/xiph/opus.git" "v1.5.2" "ddbe48383984d56acd9e1ab6a090c54ca6b735a6"
if errorlevel 1 exit /b 1

call :ensure_repo "speexdsp-1.2.1" "https://github.com/xiph/speexdsp.git" "SpeexDSP-1.2.1" "1b28a0f61bc31162979e1f26f3981fc3637095c8"
if errorlevel 1 exit /b 1

echo Dependances natives verifiees.
exit /b 0

:ensure_repo
set "NAME=%~1"
set "URL=%~2"
set "TAG=%~3"
set "COMMIT=%~4"
set "TARGET=%DEPS%\%NAME%"

if not exist "%TARGET%\.git" git clone --depth 1 --branch "%TAG%" "%URL%" "%TARGET%"
if errorlevel 1 exit /b 1

for /f "usebackq delims=" %%H in (`git -c "safe.directory=%TARGET%" -C "%TARGET%" rev-parse HEAD`) do set "ACTUAL=%%H"
if /I not "%ACTUAL%"=="%COMMIT%" (
  echo Version inattendue pour %NAME% : %ACTUAL%
  exit /b 1
)
exit /b 0
