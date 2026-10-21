package lifecycle

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/kandev/kandev/internal/agent/executor"
	"github.com/kandev/kandev/internal/agent/runtime/activity"
	agentctl "github.com/kandev/kandev/internal/agent/runtime/agentctl"
	"github.com/kandev/kandev/internal/events"
	"github.com/stretchr/testify/require"
)

type nativePoolStopFixture struct {
	manager     *Manager
	bus         *MockEventBusWithTracking
	execution   *AgentExecution
	control     *poolStopControl
	coordinator *activity.Coordinator
}

func newNativePoolStopFixture(t *testing.T, mode string, capture bool) nativePoolStopFixture {
	t.Helper()
	runtime, control := newPoolStopControl(t, mode)
	manager, tracking := createTestManagerWithTracking()
	cleanupManagerStopCh(t, manager)
	manager.executorRegistry = NewExecutorRegistry(manager.logger)
	manager.executorRegistry.Register(runtime)
	coordinator := activity.NewCoordinator(activity.Options{})
	manager.SetActivityCoordinator(coordinator)
	execution := createTestExecution("pool-execution", "pool-task", "pool-session")
	execution.AgentID, execution.AgentProfileID = "claude-acp", "pool-profile"
	execution.RuntimeName, execution.standaloneInstanceID = executor.NameStandalone, "control-instance"
	execution.setPromptTurnID("pool-turn")
	execution.agentctl = agentctl.NewClient(runtime.host, runtime.port, manager.logger)
	t.Cleanup(execution.agentctl.Close)
	require.NoError(t, manager.executionStore.Add(execution))
	if capture {
		require.NoError(t, manager.EnableWorkActivity(context.Background(), execution.ID, "pool-turn"))
	}
	_, err := manager.executionStore.BeginPrompt(execution.ID)
	require.NoError(t, err)
	lease, err := coordinator.AcquireTask(context.Background(), activity.KindExecutionRunning)
	require.NoError(t, err)
	t.Cleanup(lease.Release)
	manager.trackActivity(executionActivityKey(execution.ID), lease)
	return nativePoolStopFixture{manager: manager, bus: tracking, execution: execution, control: control, coordinator: coordinator}
}

func poolStoppedPayload(t *testing.T, f nativePoolStopFixture) map[string]json.RawMessage {
	t.Helper()
	f.bus.mu.Lock()
	defer f.bus.mu.Unlock()
	for _, published := range f.bus.PublishedEvents {
		if published.Event.Type == events.AgentStopped {
			encoded, err := json.Marshal(published.Event.Data)
			require.NoError(t, err)
			var data map[string]json.RawMessage
			require.NoError(t, json.Unmarshal(encoded, &data))
			return data
		}
	}
	t.Fatal("原生停止事件未发布")
	return nil
}

// @covers AC-TASKS-AGENT-POOL-002.3 AC-TASKS-AGENT-POOL-005.2
func TestPoolStopPublicationRequiresNativeConfirmationAndReleasesActualLease(t *testing.T) {
	f := newNativePoolStopFixture(t, "success", true)
	require.NotEmpty(t, f.coordinator.BusyKinds(), "正对照必须确实持有原生执行租约")
	require.NoError(t, f.manager.StopAgentWithReason(context.Background(), f.execution.ID, "pool-confirmed-stop", false))
	require.False(t, f.control.active.Load())
	require.Empty(t, f.coordinator.BusyKinds())
	require.Zero(t, f.control.legacyStops.Load(), "未核对范围的单进程 Stop 不能先于确认路径发生")
	data := poolStoppedPayload(t, f)
	require.NotEmpty(t, data["runtime_stop_confirmation"], "只有实际确认过的运行时停止才能携带该证据")
	var proof struct {
		Source                    string `json:"source"`
		RuntimeInstanceID         string `json:"runtime_instance_id"`
		ExecutionActivityReleased bool   `json:"execution_activity_released"`
	}
	require.NoError(t, json.Unmarshal(data["runtime_stop_confirmation"], &proof))
	require.Equal(t, "standalone_control_v1", proof.Source)
	require.Equal(t, "control-instance", proof.RuntimeInstanceID)
	require.True(t, proof.ExecutionActivityReleased)
}

// @covers AC-TASKS-AGENT-POOL-005.2
func TestPoolStopPublicationKeepsOrdinaryDefaultPathWithoutPoolProof(t *testing.T) {
	f := newNativePoolStopFixture(t, "success", false)
	require.NoError(t, f.manager.StopAgentWithReason(context.Background(), f.execution.ID, "ordinary-stop", false))
	require.False(t, f.control.active.Load())
	require.EqualValues(t, 1, f.control.legacyStops.Load())
	require.Empty(t, poolStoppedPayload(t, f)["runtime_stop_confirmation"])
}

// @covers AC-TASKS-AGENT-POOL-005.2
func TestPoolStopPublicationCannotConfirmMissingRuntimeOrForeignInstance(t *testing.T) {
	for _, mode := range []string{"missing-registry", "missing-capability", "wrong-task", "delete-failed", "unreadable-after"} {
		t.Run(mode, func(t *testing.T) {
			f := newNativePoolStopFixture(t, mode, true)
			if mode == "missing-registry" {
				f.manager.executorRegistry = nil
			}
			if mode == "missing-capability" {
				f.manager.executorRegistry = NewExecutorRegistry(f.manager.logger)
				f.manager.executorRegistry.Register(&MockExecutor{name: executor.NameStandalone})
			}
			require.Error(t, f.manager.StopAgentWithReason(context.Background(), f.execution.ID, "pool-confirmed-stop", false))
			_, tracked := f.manager.executionStore.Get(f.execution.ID)
			require.True(t, tracked, "确认失败必须保留原执行供核实")
			require.NotEmpty(t, f.coordinator.BusyKinds())
			require.Zero(t, f.control.legacyStops.Load(), "未知身份不得先调用旧 Stop")
		})
	}
}

// @covers AC-TASKS-AGENT-POOL-005.2
func TestPoolStopPublicationDoesNotMistakePendingActivityForReleasedResources(t *testing.T) {
	f := newNativePoolStopFixture(t, "success", true)
	claim, err := f.manager.ensureExecutionActivity(context.Background(), f.execution.ID, activity.KindExecutionRunning)
	require.NoError(t, err)
	require.NotNil(t, claim)
	t.Cleanup(claim.Release)
	require.NoError(t, f.manager.StopAgentWithReason(context.Background(), f.execution.ID, "pool-confirmed-stop", false))
	data := poolStoppedPayload(t, f)
	require.NotEmpty(t, data["runtime_stop_confirmation"])
	var proof struct {
		ExecutionActivityReleased bool `json:"execution_activity_released"`
	}
	require.NoError(t, json.Unmarshal(data["runtime_stop_confirmation"], &proof))
	require.False(t, proof.ExecutionActivityReleased, "使旧准备失效不等于已归还它仍持有的租约")
	require.NotEmpty(t, f.coordinator.BusyKinds())
	claim.Release()
	require.Empty(t, f.coordinator.BusyKinds())
}

// @covers AC-TASKS-AGENT-POOL-005.2
func TestPoolStopPublicationSurvivableDetachNeverIssuesStopProof(t *testing.T) {
	f := newNativePoolStopFixture(t, "success", true)
	f.manager.SetAgentSurvivalEnabled(true)
	require.NoError(t, f.manager.StopAgentWithReason(context.Background(), f.execution.ID, StopReasonBackendShutdown, false))
	require.True(t, f.control.active.Load(), "存活分支必须保留真实模拟实例")
	require.Zero(t, f.control.deletes.Load())
	f.bus.mu.Lock()
	defer f.bus.mu.Unlock()
	for _, published := range f.bus.PublishedEvents {
		require.NotEqual(t, events.AgentStopped, published.Event.Type)
	}
}

// @covers AC-TASKS-AGENT-POOL-005.2
func TestPoolStopPublicationMissingActivityCoordinatorCannotProveRelease(t *testing.T) {
	f := newNativePoolStopFixture(t, "success", true)
	f.manager.SetActivityCoordinator(nil)
	require.NoError(t, f.manager.StopAgentWithReason(context.Background(), f.execution.ID, "pool-confirmed-stop", false))
	data := poolStoppedPayload(t, f)
	require.NotEmpty(t, data["runtime_stop_confirmation"])
	var proof struct {
		ExecutionActivityReleased bool `json:"execution_activity_released"`
	}
	require.NoError(t, json.Unmarshal(data["runtime_stop_confirmation"], &proof))
	require.False(t, proof.ExecutionActivityReleased, "活动跟踪不可用不能视为资源已测得空闲")
}
