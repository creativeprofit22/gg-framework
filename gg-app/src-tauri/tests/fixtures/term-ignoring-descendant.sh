#!/bin/sh
set -eu

descendant_pid_file=$1

on_term() {
  exit 0
}
trap on_term TERM

# The group leader exits cooperatively on TERM. This descendant inherits the
# leader's process group but ignores TERM, reproducing the app-quit leak.
sh -c '
  trap "" TERM
  printf "%s\n" "$$" > "$1"
  while :; do
    sleep 60
  done
' gg-app-term-descendant "$descendant_pid_file" &

while [ ! -s "$descendant_pid_file" ]; do
  sleep 0.01
done

while :; do
  sleep 60
done
