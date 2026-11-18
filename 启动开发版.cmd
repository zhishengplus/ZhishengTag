@echo off
setlocal
if not defined ZHISHENG_TAG_DATA set "ZHISHENG_TAG_DATA=%~dp0.dev-data"
call "%~dp0Launch-ZhishengTag.cmd"
