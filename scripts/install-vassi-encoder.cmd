@echo off
setlocal

rem Ce script copie l'external compile vers le depot et vers le dossier lu par Max et Ableton.
rem Il evite qu'une ancienne version reste chargee pendant un test manuel.
set "ROOT=%~dp0.."
set "ARTIFACT=%ROOT%\.local\artifacts\vassi.encoder~.mxe64"
set "MAX_LIBRARY=%USERPROFILE%\Documents\Max 8\Library\Vassi Stream\externals"

if not exist "%ARTIFACT%" goto missing_artifact

copy /Y "%ARTIFACT%" "%ROOT%\externals\vassi.encoder~.mxe64" >nul
if errorlevel 1 goto copy_failed

if not exist "%MAX_LIBRARY%" mkdir "%MAX_LIBRARY%"
copy /Y "%ARTIFACT%" "%MAX_LIBRARY%\vassi.encoder~.mxe64" >nul
if errorlevel 1 goto copy_failed

echo External installe dans externals et dans "%MAX_LIBRARY%".
echo Fermer puis rouvrir Max ou Ableton pour charger cette version.
exit /b 0

:missing_artifact
echo Artefact introuvable : executez d'abord scripts\build-vassi-encoder.cmd.
exit /b 1

:copy_failed
echo Copie impossible : fermer Max ou Ableton puis relancer ce script.
exit /b 1
