package acceptance

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func TestCheckerUsesConfiguredRootAndFailsClosed(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("进程契约测试需要 Node 24")
	}
	root := t.TempDir()
	script := filepath.Join(root, "checker.mjs")
	encodedRoot, _ := json.Marshal(root)
	source := `let raw='';for await(const part of process.stdin)raw+=part;const input=JSON.parse(raw);
if(input.repo_root!==` + string(encodedRoot) + `||input.head_branch!=='task/fixture')process.exit(3);
const mode=input.task.result;if(mode==='overflow'){process.stdout.write('x'.repeat(600000));process.exit(0)}
const result={format:'ai-fleet-delivery-check/v1',status:mode==='fail'?'fail':'pass',head:'commit',fingerprint:mode==='stale'?'changed':'fingerprint',rules_version:'rules'};
process.stdout.write(JSON.stringify(result));process.exit(mode==='fail'?2:0);`
	if err := os.WriteFile(script, []byte(source), 0600); err != nil {
		t.Fatal(err)
	}
	checker := Checker{NodePath: node, ScriptPath: script, RepositoryID: "repo", RepositoryRoot: root}
	for _, mode := range []string{"pass", "fail", "stale", "overflow"} {
		t.Run(mode, func(t *testing.T) {
			value := map[string]any{"format": "fleet-acceptance/v1", "task_id": "task", "repository_id": "repo", "repo_root": "untrusted-path", "head_branch": "task/fixture", "implementation_session_id": "implementation", "review_session_id": "review", "task": map[string]string{"result": mode}, "check": map[string]string{"status": "pass", "head": "commit", "fingerprint": "fingerprint", "rules_version": "rules"}}
			summary, _ := json.Marshal(value)
			err := checker.Check(context.Background(), "task", string(summary))
			if mode == "pass" {
				if err != nil {
					t.Fatal(err)
				}
			} else if !errors.Is(err, ErrInvalidReceipt) {
				t.Fatalf("无效结果未拒绝: %v", err)
			}
		})
	}
	if !errors.Is(checker.Check(context.Background(), "task", `{}`), ErrInvalidReceipt) {
		t.Fatal("不完整回执被接受")
	}
}
