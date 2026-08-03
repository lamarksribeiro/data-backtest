#!/bin/bash
hostname
uname -a
docker ps 2>/dev/null | head -40
echo "---"
docker ps -a 2>/dev/null | grep -iE 'colect|collector|data-colector|fracta' | head -20
