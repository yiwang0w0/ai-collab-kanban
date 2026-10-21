package backendapp

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/cookiejar"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
)

type poolBinaryHost struct {
	baseURL      string
	home         string
	root         string
	client       *http.Client
	command      *exec.Cmd
	done         chan struct{}
	logPath      string
	nonce        string
	stoppedTasks map[string]bool
}

func newPoolBinaryHost(t *testing.T) *poolBinaryHost {
	t.Helper()
	binary := os.Getenv("KANDEV_POOL_HOST_BIN")
	if binary == "" {
		t.Skip("真实宿主验收需显式提供 KANDEV_POOL_HOST_BIN")
	}
	require.FileExists(t, binary)
	for _, name := range []string{"agentctl", "mock-agent"} {
		require.FileExists(t, filepath.Join(filepath.Dir(binary), name+filepath.Ext(binary)))
	}
	root := t.TempDir()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	address := listener.Addr().String()
	require.NoError(t, listener.Close())
	jar, err := cookiejar.New(nil)
	require.NoError(t, err)
	f := &poolBinaryHost{baseURL: "http://" + address, home: filepath.Join(root, "h"), root: root,
		client: &http.Client{Jar: jar, Timeout: 15 * time.Second}, done: make(chan struct{}), logPath: filepath.Join(root, "host.log"), stoppedTasks: make(map[string]bool)}
	logFile, err := os.Create(f.logPath)
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, logFile.Close()) })
	nonce := uuid.NewString()
	f.nonce = nonce
	f.command = exec.Command(binary, "__backend")
	f.command.Dir = root
	f.command.Env = poolBinaryEnvironment(t, binary, root, address, nonce)
	f.command.Stdout, f.command.Stderr = logFile, logFile
	hidePoolHostWindow(f.command)
	f.prepareRepository(t)
	f.startCommand(t)
	t.Cleanup(func() {
		select {
		case <-f.done:
		default:
			require.NoError(t, f.command.Process.Kill())
			<-f.done
		}
		if t.Failed() {
			data, err := os.ReadFile(f.logPath)
			if err == nil {
				t.Logf("隔离宿主日志末尾：%s", data[max(0, len(data)-3500):])
			}
		}
	})
	f.waitReady(t, nonce)
	return f
}

func poolBinaryEnvironment(t *testing.T, binary, root, address, nonce string) []string {
	t.Helper()
	_, port, err := net.SplitHostPort(address)
	require.NoError(t, err)
	env := make([]string, 0)
	for _, entry := range os.Environ() {
		key := strings.ToUpper(strings.SplitN(entry, "=", 2)[0])
		if poolHostPrivateEnvironment(key) {
			continue
		}
		env = append(env, entry)
	}
	values := map[string]string{
		"KANDEV_HOME_DIR": filepath.Join(root, "h"), "KANDEV_DATABASE_PATH": filepath.Join(root, "h", "data", "kandev.db"),
		"KANDEV_SERVER_HOST": "127.0.0.1", "KANDEV_SERVER_PORT": port, "KANDEV_E2E_MOCK": "true",
		"KANDEV_MOCK_AGENT": "only", "KANDEV_MOCK_PROVIDERS": "claude-acp", "KANDEV_FEATURES_AUTH": "true",
		"KANDEV_DOCKER_ENABLED": "false", "KANDEV_WORKTREE_ENABLED": "true", "KANDEV_LOG_LEVEL": "error",
		"KANDEV_DESKTOP_HEALTH_TOKEN": nonce, "KANDEV_WORKTREE_BASEPATH": filepath.Join(root, "wt"),
		"KANDEV_REPOCLONE_BASEPATH": filepath.Join(root, "clones"), "KANDEV_WEB_DIST_DIR": os.Getenv("KANDEV_POOL_HOST_WEB_DIST"),
		"HOME": root, "USERPROFILE": root, "APPDATA": filepath.Join(root, "appdata"), "LOCALAPPDATA": filepath.Join(root, "local"),
		"PATH":              filepath.Dir(binary) + string(os.PathListSeparator) + os.Getenv("PATH"),
		"GIT_CONFIG_GLOBAL": os.DevNull, "GIT_CONFIG_NOSYSTEM": "1",
		"KANDEV_COMPLETION_VERIFIER_ID":   "plugin:pool-host-pending",
		"KANDEV_COMPLETION_NODE_PATH":     os.Getenv("KANDEV_POOL_HOST_NODE"),
		"KANDEV_COMPLETION_CHECKER_PATH":  os.Getenv("KANDEV_POOL_HOST_CHECKER"),
		"KANDEV_COMPLETION_REPOSITORY_ID": "pool-host-pending", "KANDEV_COMPLETION_REPOSITORY_ROOT": filepath.Join(root, "r"),
		"E2E_MOCK_AGENT_ACP_TRACE_FILE": filepath.Join(root, "trace.jsonl"),
	}
	for key, value := range values {
		env = append(env, key+"="+value)
	}
	return env
}

func (f *poolBinaryHost) prepareRepository(t *testing.T) {
	t.Helper()
	require.FileExists(t, os.Getenv("KANDEV_POOL_HOST_NODE"))
	require.FileExists(t, os.Getenv("KANDEV_POOL_HOST_CHECKER"))
	repository := filepath.Join(f.root, "r")
	require.NoError(t, os.MkdirAll(filepath.Join(repository, "src"), 0700))
	require.NoError(t, os.WriteFile(filepath.Join(repository, "src", "app.js"), []byte("export const value = 1;\n"), 0600))
	for _, args := range [][]string{{"init", "-qb", "main"}, {"add", "."},
		{"-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "pool fixture"}} {
		cmd := exec.Command("git", append([]string{"-C", repository}, args...)...)
		cmd.Env = f.command.Env
		hidePoolHostWindow(cmd)
		output, err := cmd.CombinedOutput()
		require.NoError(t, err, string(output))
	}
}

func poolHostPrivateEnvironment(key string) bool {
	if key == "PATH" || key == "HOME" || key == "USERPROFILE" || key == "APPDATA" || key == "LOCALAPPDATA" || strings.HasPrefix(key, "GIT_") {
		return true
	}
	for _, prefix := range []string{"KANDEV_", "AGENTCTL_", "E2E_", "OPENAI_", "ANTHROPIC_", "CLAUDE_", "CODEX_", "AWS_", "AZURE_", "GITHUB_", "GH_", "GITLAB_", "OTEL_", "NATS_"} {
		if strings.HasPrefix(key, prefix) {
			return true
		}
	}
	return strings.Contains(key, "_TOKEN") || strings.Contains(key, "_SECRET") || strings.Contains(key, "_API_KEY")
}

func (f *poolBinaryHost) waitReady(t *testing.T, nonce string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), 90*time.Second)
	defer cancel()
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-f.done:
			t.Fatal("隔离宿主在就绪前已退出")
		case <-ctx.Done():
			t.Fatal("隔离宿主就绪超时")
		case <-ticker.C:
			health, err := f.client.Get(f.baseURL + "/health")
			if err != nil {
				continue
			}
			owned := health.Header.Get(desktopHealthTokenHeader) == nonce
			require.NoError(t, health.Body.Close())
			if !owned {
				t.Fatal("监听端口未证明属于本次私有宿主，禁止写入")
			}
			ready, err := f.client.Get(f.baseURL + "/ready")
			if err == nil {
				require.NoError(t, ready.Body.Close())
				if ready.StatusCode == http.StatusOK {
					return
				}
			}
		}
	}
}

func (f *poolBinaryHost) call(t *testing.T, method, path string, data any, interlock string) (int, []byte) {
	t.Helper()
	body, err := json.Marshal(data)
	require.NoError(t, err)
	req, err := http.NewRequestWithContext(t.Context(), method, f.baseURL+path, bytes.NewReader(body))
	require.NoError(t, err)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Origin", f.baseURL)
	if interlock != "" {
		req.Header.Set("X-Kandev-Interim-Settings-Interlock", interlock)
	}
	response, err := f.client.Do(req)
	require.NoError(t, err)
	defer response.Body.Close()
	encoded, err := io.ReadAll(io.LimitReader(response.Body, 8*1024*1024))
	require.NoError(t, err)
	return response.StatusCode, encoded
}

func (f *poolBinaryHost) request(t *testing.T, method, path string, data any, result any) {
	t.Helper()
	status, body := f.call(t, method, path, data, f.interlock(t, method, path))
	require.True(t, status == http.StatusOK || status == http.StatusCreated, fmt.Sprintf("%s %s：%d %s", method, path, status, body))
	if result != nil {
		require.NoError(t, json.Unmarshal(body, result))
	}
}

func (f *poolBinaryHost) interlock(t *testing.T, method, path string) string {
	t.Helper()
	if method == http.MethodGet || path == "/api/v1/auth/setup" {
		return ""
	}
	status, body := f.call(t, http.MethodGet, "/api/v1/app-state?path=%2Fsettings%2Fagents", nil, "")
	require.Equal(t, http.StatusOK, status, string(body))
	var state struct {
		Token string `json:"interimSettingsInterlockToken"`
	}
	require.NoError(t, json.Unmarshal(body, &state))
	require.NotEmpty(t, state.Token)
	return state.Token
}
