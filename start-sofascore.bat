@echo off
cd /d "%~dp0Public-Sofascore-API\sofascore_service"
call venv\Scripts\activate.bat
python manage.py runserver 8000
