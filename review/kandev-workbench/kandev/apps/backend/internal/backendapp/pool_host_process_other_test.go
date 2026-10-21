//go:build !windows

package backendapp

import "os/exec"

func hidePoolHostWindow(*exec.Cmd) {}
