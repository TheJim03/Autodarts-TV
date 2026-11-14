@echo off
rem Installiert die Debug-APK per adb auf einer TV-Box.
rem Aufruf: install-tv.bat <TV-IP>   (oder Umgebungsvariable TV_IP setzen)
setlocal
set "IP=%~1"
if "%IP%"=="" set "IP=%TV_IP%"
if "%IP%"=="" (echo Bitte die IP des TVs angeben: install-tv.bat ^<TV-IP^> & goto :end)
set "ADB=%LOCALAPPDATA%\Android\Sdk\platform-tools\adb.exe"
set "APK=%~dp0..\app\build\outputs\apk\debug\app-debug.apk"

if not exist "%ADB%" (echo adb nicht gefunden: %ADB% & goto :end)
if not exist "%APK%" (echo APK nicht gefunden: %APK% & goto :end)

echo Verbinde mit %IP%:5555 ...
"%ADB%" connect %IP%:5555
echo.
echo Falls auf dem TV "Debugging zulassen?" erscheint: jetzt bestaetigen.
pause
"%ADB%" -s %IP%:5555 install -r "%APK%"
if errorlevel 1 (
  echo.
  echo Installation fehlgeschlagen. Bei INSTALL_FAILED_UPDATE_INCOMPATIBLE:
  echo   "%ADB%" -s %IP%:5555 uninstall io.autodarts.tv
  goto :end
)
"%ADB%" -s %IP%:5555 shell monkey -p io.autodarts.tv -c android.intent.category.LEANBACK_LAUNCHER 1 >nul 2>&1
echo.
echo Fertig, die App sollte auf dem TV starten.
:end
echo.
pause
