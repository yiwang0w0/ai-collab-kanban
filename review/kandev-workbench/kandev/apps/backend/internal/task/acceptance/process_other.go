//go:build !windows

package acceptance

import "os/exec"

func hideWindow(cmd *exec.Cmd) {}
