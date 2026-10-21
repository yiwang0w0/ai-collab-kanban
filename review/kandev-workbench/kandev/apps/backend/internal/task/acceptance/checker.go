package acceptance

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os/exec"
	"time"
)

var ErrInvalidReceipt = errors.New("验收回执失效或不可测")

type Checker struct{ NodePath, ScriptPath, RepositoryID, RepositoryRoot string }

type receipt struct {
	Format                  string          `json:"format"`
	TaskID                  string          `json:"task_id"`
	RepositoryID            string          `json:"repository_id"`
	HeadBranch              string          `json:"head_branch"`
	ImplementationSessionID string          `json:"implementation_session_id"`
	ReviewSessionID         string          `json:"review_session_id"`
	Task                    json.RawMessage `json:"task"`
	Check                   struct {
		Status       string `json:"status"`
		Head         string `json:"head"`
		Fingerprint  string `json:"fingerprint"`
		RulesVersion string `json:"rules_version"`
	} `json:"check"`
}

func (r receipt) validFor(taskID, repositoryID string) bool {
	return r.Format == "fleet-acceptance/v1" && r.TaskID == taskID && r.RepositoryID == repositoryID &&
		r.HeadBranch != "" && r.ImplementationSessionID != "" && r.ReviewSessionID != "" && r.ImplementationSessionID != r.ReviewSessionID &&
		r.Check.Status == "pass" && r.Check.Head != "" && r.Check.Fingerprint != "" && r.Check.RulesVersion != ""
}

// 这里只执行同一份无服务的校验脚本，不连接旧看板，也不信任回执中的磁盘路径。
func (c Checker) Check(ctx context.Context, taskID, summary string) error {
	var value receipt
	if json.Unmarshal([]byte(summary), &value) != nil || !value.validFor(taskID, c.RepositoryID) {
		return ErrInvalidReceipt
	}
	input, err := json.Marshal(map[string]any{"format": "ai-fleet-delivery-input/v1", "repo_root": c.RepositoryRoot, "head_branch": value.HeadBranch, "task": value.Task, "expected": value.Check})
	if err != nil {
		return ErrInvalidReceipt
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, c.NodePath, c.ScriptPath)
	hideWindow(cmd)
	cmd.Stdin = bytes.NewReader(input)
	output := &boundedOutput{}
	cmd.Stdout = output
	cmd.Stderr = io.Discard
	cmd.WaitDelay = time.Second
	if cmd.Run() != nil {
		return ErrInvalidReceipt
	}
	var result struct {
		Format       string `json:"format"`
		Status       string `json:"status"`
		Head         string `json:"head"`
		Fingerprint  string `json:"fingerprint"`
		RulesVersion string `json:"rules_version"`
	}
	if json.Unmarshal(output.Bytes(), &result) != nil || result.Format != "ai-fleet-delivery-check/v1" || result.Status != "pass" || result.Head != value.Check.Head || result.Fingerprint != value.Check.Fingerprint || result.RulesVersion != value.Check.RulesVersion {
		return ErrInvalidReceipt
	}
	return nil
}

type boundedOutput struct{ bytes.Buffer }

func (w *boundedOutput) Write(data []byte) (int, error) {
	if w.Len()+len(data) > 512*1024 {
		return 0, ErrInvalidReceipt
	}
	return w.Buffer.Write(data)
}
