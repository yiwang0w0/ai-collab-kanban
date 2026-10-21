package service_test

import (
	"context"
	"strings"
	"sync"
	"testing"

	runsmodels "github.com/kandev/kandev/internal/runs/models"
	"github.com/stretchr/testify/require"
)

// @covers AC-TASKS-AGENT-POOL-002.3 AC-TASKS-AGENT-POOL-005.2
func TestPoolExecutionStoppedRejectsUnknownSourceAndForeignAllocation(t *testing.T) {
	for _, kind := range []string{"source", "runtime-id", "long-id", "task", "session", "profile", "execution", "turn", "generation", "agent-type", "operation", "work-source"} {
		t.Run(kind, func(t *testing.T) {
			f, identity, signal := poolActivityFixture(t, "codex-app-server")
			signal.StartedSource, signal.OperationID = "", ""
			source, runtimeID := "standalone_control_v1", "control-instance"
			switch kind {
			case "source":
				source = "agent.stopped"
			case "runtime-id":
				runtimeID = ""
			case "long-id":
				runtimeID = strings.Repeat("x", 257)
			case "task":
				signal.TaskID = "other-task"
			case "session":
				signal.SessionID = "old-session"
			case "profile":
				signal.AgentProfileID = "other-profile"
			case "execution":
				signal.ExecutionID = "old-execution"
			case "turn":
				signal.TurnID = "old-turn"
			case "generation":
				signal.PromptGeneration++
			case "agent-type":
				signal.AgentType = "claude-acp"
			case "operation":
				signal.OperationID = "unverified-provider-operation"
			case "work-source":
				signal.StartedSource = runsmodels.PoolStartAssistant
			}
			event, _ := poolExecutionStopRecorderFor(t, f.svc).ObservePoolExecutionStopped(context.Background(), signal, source, runtimeID, true)
			require.Nil(t, event)
			events, err := f.runs.ListRunEvents(context.Background(), identity.RunID, -1, 10)
			require.NoError(t, err)
			require.Len(t, events, 2)
		})
	}
}

// @covers AC-TASKS-AGENT-POOL-002.3 AC-TASKS-AGENT-POOL-005.2
func TestPoolExecutionStoppedCannotRewriteFirstObservation(t *testing.T) {
	f, identity, signal := poolActivityFixture(t, "claude-acp")
	signal.StartedSource = ""
	recorder := poolExecutionStopRecorderFor(t, f.svc)
	ctx := context.Background()
	first, err := recorder.ObservePoolExecutionStopped(ctx, signal, "standalone_control_v1", "control-instance", false)
	require.NoError(t, err)
	for _, runtimeID := range []string{"control-instance", "replacement-instance"} {
		conflict, err := recorder.ObservePoolExecutionStopped(ctx, signal, "standalone_control_v1", runtimeID, true)
		require.Error(t, err)
		require.Nil(t, conflict, "后续资源核验必须另有证据，不能改写第一次停止事实")
	}
	events, err := f.runs.ListRunEvents(ctx, identity.RunID, -1, 10)
	require.NoError(t, err)
	require.Len(t, events, 3)
	require.Equal(t, first, events[2])
}

// @covers AC-TASKS-AGENT-POOL-002.3 AC-TASKS-AGENT-POOL-005.2
func TestPoolExecutionStoppedCommitFailureReturnsNoEvidence(t *testing.T) {
	f, identity, signal := poolActivityFixture(t, "claude-acp")
	signal.StartedSource = ""
	mustPoolAllocationExec(t, f, `CREATE TABLE pool_stop_commit_guard (id TEXT PRIMARY KEY, run_id TEXT,
		FOREIGN KEY (run_id) REFERENCES runs(id) DEFERRABLE INITIALLY DEFERRED)`)
	mustPoolAllocationExec(t, f, `CREATE TRIGGER fail_pool_stop_commit AFTER INSERT ON run_events
		WHEN NEW.event_type = 'pool.execution-stopped.v1' BEGIN
		INSERT INTO pool_stop_commit_guard (id, run_id) VALUES ('bad', 'nonexistent-run'); END`)
	event, err := poolExecutionStopRecorderFor(t, f.svc).ObservePoolExecutionStopped(context.Background(), signal, "standalone_control_v1", "control-instance", true)
	require.Error(t, err)
	require.Nil(t, event)
	events, err := f.runs.ListRunEvents(context.Background(), identity.RunID, -1, 10)
	require.NoError(t, err)
	require.Len(t, events, 2)
}

// @covers AC-TASKS-AGENT-POOL-002.3
func TestPoolExecutionStoppedConcurrentReplayKeepsSingleEvent(t *testing.T) {
	f, identity, signal := poolActivityFixture(t, "claude-acp")
	signal.StartedSource = ""
	recorder := poolExecutionStopRecorderFor(t, f.svc)
	const count = 8
	start := make(chan struct{})
	results := make(chan *runsmodels.RunEvent, count)
	errors := make(chan error, count)
	var joined sync.WaitGroup
	for range count {
		joined.Add(1)
		go func() {
			defer joined.Done()
			<-start
			event, err := recorder.ObservePoolExecutionStopped(context.Background(), signal, "standalone_control_v1", "control-instance", true)
			results <- event
			errors <- err
		}()
	}
	close(start)
	joined.Wait()
	close(results)
	close(errors)
	for err := range errors {
		require.NoError(t, err)
	}
	var first *runsmodels.RunEvent
	for event := range results {
		require.NotNil(t, event)
		if first == nil {
			first = event
		}
		require.Equal(t, first, event)
	}
	events, err := f.runs.ListRunEvents(context.Background(), identity.RunID, -1, 10)
	require.NoError(t, err)
	require.Len(t, events, 3)
}
