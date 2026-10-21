package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os/exec"
	"time"
)

func runDeliveryCheck(ctx context.Context, cfg settings, input deliveryInput) (deliveryCheck, error) {
	var result deliveryCheck
	data, err := json.Marshal(input)
	if err != nil {
		return result, err
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, cfg.NodePath, cfg.CheckerPath)
	hideWindow(cmd)
	cmd.Stdin = bytes.NewReader(data)
	cmd.Stderr = io.Discard
	output := &boundedOutput{}
	cmd.Stdout = output
	cmd.WaitDelay = time.Second
	err = cmd.Run()
	var exited *exec.ExitError
	if err != nil && (!errors.As(err, &exited) || (exited.ExitCode() != 2 && exited.ExitCode() != 3)) {
		return result, refuse(503, "无法运行交付校验，请检查 Node 与脚本配置")
	}
	if json.Unmarshal(output.Bytes(), &result) != nil || result.Format != "ai-fleet-delivery-check/v1" || (result.Status != "pass" && result.Status != "fail" && result.Status != "unmeasurable") {
		return result, refuse(503, "交付校验输出无效，任务保持阻塞")
	}
	if result.Status == "pass" && (err != nil || result.Head == "" || result.Fingerprint == "" || result.RulesVersion == "") {
		return result, refuse(503, "交付校验未产生有效证明")
	}
	return result, nil
}

type boundedOutput struct{ bytes.Buffer }

func (w *boundedOutput) Write(data []byte) (int, error) {
	if w.Len()+len(data) > 256*1024 {
		return 0, refuse(503, "校验输出超过限制")
	}
	return w.Buffer.Write(data)
}
