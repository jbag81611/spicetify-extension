@echo off
chcp 65001 >nul
powershell -NoProfile -ExecutionPolicy Bypass -Command "iwr -useb https://raw.githubusercontent.com/jbag81611/spicetify-extension/main/installer/install.ps1 | iex"
