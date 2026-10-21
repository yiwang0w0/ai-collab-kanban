package lifecycle

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"

	agentctl "github.com/kandev/kandev/internal/agent/runtime/agentctl"
	"github.com/stretchr/testify/require"
)

type poolConfirmedInstanceStopper interface {
	StopInstanceConfirmed(context.Context, *ExecutorInstance, bool) (bool, error)
}

type poolStopControl struct {
	active      atomic.Bool
	gets        atomic.Int64
	deletes     atomic.Int64
	legacyStops atomic.Int64
}

func newPoolStopControl(t *testing.T, mode string) (*StandaloneExecutor, *poolStopControl) {
	t.Helper()
	state := &poolStopControl{}
	state.active.Store(true)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost && r.URL.Path == "/api/v1/stop" {
			state.legacyStops.Add(1)
			w.WriteHeader(http.StatusOK)
			return
		}
		if r.URL.Path != "/api/v1/instances/control-instance" {
			http.NotFound(w, r)
			return
		}
		if r.Method == http.MethodDelete {
			state.deletes.Add(1)
			if mode == "delete-failed" {
				w.WriteHeader(http.StatusServiceUnavailable)
				_, _ = w.Write([]byte(`{"error":"stop failed"}`))
				return
			}
			if mode != "still-present" {
				state.active.Store(false)
			}
			w.WriteHeader(http.StatusNoContent)
			return
		}
		count := state.gets.Add(1)
		if mode == "unreadable-before" || (mode == "unreadable-after" && count > 1) {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		if mode == "missing-before" || !state.active.Load() {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		info := agentctl.InstanceInfo{ID: "control-instance", TaskID: "pool-task", SessionID: "pool-session", Status: "running"}
		switch mode {
		case "wrong-id":
			info.ID = "other-instance"
		case "wrong-task":
			info.TaskID = "other-task"
		case "wrong-session":
			info.SessionID = "other-session"
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(info)
	}))
	t.Cleanup(server.Close)
	host, portText, err := net.SplitHostPort(strings.TrimPrefix(server.URL, "http://"))
	require.NoError(t, err)
	port, err := strconv.Atoi(portText)
	require.NoError(t, err)
	client := agentctl.NewControlClient(host, port, newTestLogger())
	t.Cleanup(client.Close)
	return NewStandaloneExecutor(client, host, port, newTestLogger()), state
}

func poolStopInstance() *ExecutorInstance {
	return &ExecutorInstance{InstanceID: "pool-execution", TaskID: "pool-task", SessionID: "pool-session", StandaloneInstanceID: "control-instance"}
}

func confirmedStopperFor(t *testing.T, runtime *StandaloneExecutor) poolConfirmedInstanceStopper {
	t.Helper()
	stopper, ok := any(runtime).(poolConfirmedInstanceStopper)
	require.True(t, ok, "原生 standalone 缺少同一实例范围的停止确认能力")
	return stopper
}

// @covers AC-TASKS-AGENT-POOL-002.3 AC-TASKS-AGENT-POOL-005.2
func TestPoolStopConfirmationUsesNativeControlAndVerifiesPostcondition(t *testing.T) {
	runtime, state := newPoolStopControl(t, "success")
	confirmed, err := confirmedStopperFor(t, runtime).StopInstanceConfirmed(context.Background(), poolStopInstance(), false)
	require.NoError(t, err)
	require.True(t, confirmed)
	require.False(t, state.active.Load())
	require.EqualValues(t, 1, state.deletes.Load())
	require.EqualValues(t, 2, state.gets.Load(), "先核对实际实例范围，再确认删除后的真实缺席")
}

// @covers AC-TASKS-AGENT-POOL-002.3 AC-TASKS-AGENT-POOL-005.2
func TestPoolStopConfirmationRejectsUnknownScopeAndUnverifiedDeletion(t *testing.T) {
	for _, mode := range []string{"wrong-id", "wrong-task", "wrong-session", "missing-before", "unreadable-before", "delete-failed", "still-present", "unreadable-after"} {
		t.Run(mode, func(t *testing.T) {
			runtime, state := newPoolStopControl(t, mode)
			confirmed, err := confirmedStopperFor(t, runtime).StopInstanceConfirmed(context.Background(), poolStopInstance(), false)
			require.Error(t, err)
			require.False(t, confirmed)
			if strings.HasPrefix(mode, "wrong-") || mode == "missing-before" || mode == "unreadable-before" {
				require.Zero(t, state.deletes.Load(), "未核对身份不得停止候选实例")
			}
		})
	}
}

// @covers AC-TASKS-AGENT-POOL-005.2
func TestPoolStopConfirmationRejectsMissingHostIdentityBeforeControlIO(t *testing.T) {
	changes := map[string]func(*ExecutorInstance){
		"execution": func(i *ExecutorInstance) { i.InstanceID = "" },
		"task":      func(i *ExecutorInstance) { i.TaskID = "" },
		"session":   func(i *ExecutorInstance) { i.SessionID = "" },
		"runtime":   func(i *ExecutorInstance) { i.StandaloneInstanceID = "" },
	}
	for name, change := range changes {
		t.Run(name, func(t *testing.T) {
			runtime, state := newPoolStopControl(t, "success")
			instance := poolStopInstance()
			change(instance)
			confirmed, err := confirmedStopperFor(t, runtime).StopInstanceConfirmed(context.Background(), instance, false)
			require.Error(t, err)
			require.False(t, confirmed)
			require.Zero(t, state.gets.Load())
			require.Zero(t, state.deletes.Load())
		})
	}
}

// @covers AC-TASKS-AGENT-POOL-005.2
func TestPoolStopConfirmationNilBoundariesRemainUnconfirmed(t *testing.T) {
	for name, runtime := range map[string]*StandaloneExecutor{"nil-runtime": nil, "missing-control": {}} {
		t.Run(name, func(t *testing.T) {
			confirmed, err := confirmedStopperFor(t, runtime).StopInstanceConfirmed(context.Background(), poolStopInstance(), false)
			require.ErrorIs(t, err, ErrExecutionStopUnconfirmed)
			require.False(t, confirmed)
		})
	}
	runtime, state := newPoolStopControl(t, "success")
	confirmed, err := confirmedStopperFor(t, runtime).StopInstanceConfirmed(context.Background(), nil, false)
	require.ErrorIs(t, err, ErrExecutionStopUnconfirmed)
	require.False(t, confirmed)
	require.Zero(t, state.gets.Load())
	require.Zero(t, state.deletes.Load())
}
