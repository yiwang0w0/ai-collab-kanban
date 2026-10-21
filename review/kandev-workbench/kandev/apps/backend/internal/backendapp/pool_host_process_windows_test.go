package backendapp

import (
	"os/exec"
	"syscall"
)

func hidePoolHostWindow(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
}
