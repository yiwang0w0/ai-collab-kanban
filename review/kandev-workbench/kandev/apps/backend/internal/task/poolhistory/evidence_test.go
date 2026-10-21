package poolhistory

import (
	"encoding/json"
	"testing"
	"time"

	runsmodels "github.com/kandev/kandev/internal/runs/models"
	"github.com/kandev/kandev/internal/steptelemetry"
	"github.com/stretchr/testify/require"
)

// 此夹具复用原生序列化类型及身份工厂，仅证明消费者契约，不冒充实际模型或宿主执行。
func receiptSnapshot(t *testing.T, finished bool) *Snapshot {
	t.Helper()
	at := time.Date(2026, 10, 19, 0, 0, 0, 0, time.UTC)
	release := runsmodels.PoolReleaseSnapshot{TaskID: "task", WorkspaceID: "workspace", WorkflowID: "workflow",
		WorkflowStepID: "step", EntryID: 1, AgentProfileID: "profile", ActorID: "human", ReleasedAt: at}
	key, err := release.DispatchKey()
	require.NoError(t, err)
	payload, err := json.Marshal(map[string]any{"task_id": release.TaskID, "workflow_step_id": release.WorkflowStepID,
		"agent_profile_id": release.AgentProfileID, "pool_release": release})
	require.NoError(t, err)
	claimedAt := at.Add(2 * time.Second)
	run := &runsmodels.Run{ID: "run", WorkspaceID: release.WorkspaceID, AgentProfileID: release.AgentProfileID,
		Reason: runsmodels.PoolDispatchReason, Status: runsmodels.RunStatusClaimed, IdempotencyKey: &key, Payload: string(payload),
		ActorKind: runsmodels.ActorKindUser, ActorID: release.ActorID, CoalescedCount: 1, RequestedAt: at.Add(time.Second),
		ClaimedAt: &claimedAt, SessionID: "session"}
	request, err := (&runsmodels.ClaimedRun{Run: run, ClaimID: "claim"}).PoolStartRequest()
	require.NoError(t, err)
	allocation := runsmodels.PoolExecutionAllocation{PoolExecutionIdentity: runsmodels.PoolExecutionIdentity{
		RunID: run.ID, ClaimID: "claim", TaskID: release.TaskID, AgentProfileID: release.AgentProfileID, ExecutionProfileID: release.AgentProfileID,
		SessionID: "session", ExecutionID: "execution", TurnID: "turn", PromptGeneration: 1}, AgentType: "claude-acp"}
	require.True(t, allocation.ValidAllocationFor(request))
	activity := runsmodels.PoolExecutionActivity{TaskID: "task", AgentProfileID: "profile", SessionID: "session",
		ExecutionID: "execution", TurnID: "turn", PromptGeneration: 1, AgentType: "claude-acp", StartedSource: runsmodels.PoolStartAssistant}
	bound, ok := activity.ReceiptIdentity(allocation)
	require.True(t, ok)
	snapshot := &Snapshot{TaskID: "task", WorkspaceID: "workspace", LatestEntryID: 1, CurrentWorkflowID: "workflow", CurrentStepID: "step",
		Entries: []Entry{{ID: 1, WorkflowID: "workflow", StepID: "step", ActorKind: "human", ActorID: "human",
			ContractVersion: steptelemetry.ContractVersion, OccurredAt: at, PlannedProfile: "profile"}},
		Runs: []*runsmodels.Run{run}, Selections: []Selection{{EntryID: 1, RunID: "run", ClaimID: "claim", WorkspaceID: "workspace", ClaimedAt: &claimedAt}},
		ClaimCounts: []ClaimCount{{RunID: "run", Total: 1, CurrentMatches: 1}}}
	appendReceiptFixture(t, snapshot, runsmodels.PoolLaunchAdmitted, request, at)
	appendReceiptFixture(t, snapshot, runsmodels.PoolExecutionAllocated, allocation, at)
	appendReceiptFixture(t, snapshot, runsmodels.PoolExecutionBound, bound, at)
	appendReceiptFixture(t, snapshot, runsmodels.PoolWorkObserved, runsmodels.PoolWorkReceipt{PoolExecutionIdentity: bound, StartedSource: activity.StartedSource}, at)
	if finished {
		activity.StartedSource = ""
		turn, ok := activity.TurnEndIdentity(allocation)
		require.True(t, ok)
		appendReceiptFixture(t, snapshot, runsmodels.PoolTurnEnded, runsmodels.PoolTurnEndReceipt{PoolExecutionIdentity: turn, Outcome: runsmodels.PoolTurnCompleted}, at)
		stop, ok := activity.StoppedReceipt(allocation, runsmodels.PoolStopStandaloneControl, "fixture-control", true)
		require.True(t, ok)
		stopped := appendReceiptFixture(t, snapshot, runsmodels.PoolExecutionStopped, stop, at)
		ended := appendReceiptFixture(t, snapshot, runsmodels.PoolExecutionFinished, runsmodels.PoolExecutionFinishReceipt{
			PoolExecutionIdentity: allocation.PoolExecutionIdentity, StoppedSeq: stopped.Seq}, at)
		run.Status, run.FinishedAt = runsmodels.RunStatusFinished, &ended.CreatedAt
		outcome := runsmodels.PoolOutcomeExecutionStopped
		run.Outcome = &outcome
	}
	return snapshot
}

func appendReceiptFixture(t *testing.T, snapshot *Snapshot, kind string, value any, at time.Time) *runsmodels.RunEvent {
	t.Helper()
	payload, err := json.Marshal(value)
	require.NoError(t, err)
	event := &runsmodels.RunEvent{RunID: "run", Seq: len(snapshot.Events), EventType: runsmodels.RunEventType(kind),
		Payload: string(payload), CreatedAt: at.Add(time.Duration(len(snapshot.Events)+3) * time.Second)}
	snapshot.Events = append(snapshot.Events, event)
	return event
}

func mutateWorkReceipt(t *testing.T, snapshot *Snapshot, mutate func(*runsmodels.PoolWorkReceipt)) {
	t.Helper()
	for _, event := range snapshot.Events {
		if event.EventType != runsmodels.PoolWorkObserved {
			continue
		}
		var value runsmodels.PoolWorkReceipt
		require.NoError(t, json.Unmarshal([]byte(event.Payload), &value))
		mutate(&value)
		payload, err := json.Marshal(value)
		require.NoError(t, err)
		event.Payload = string(payload)
		return
	}
	t.Fatal("缺少实际形状的工作回执夹具")
}

// @covers AC-TASKS-AGENT-POOL-002.2 AC-TASKS-AGENT-POOL-002.3
func TestPoolHistoryReceiptRejectsMismatchedOrUnsupportedWork(t *testing.T) {
	for _, test := range []struct {
		name   string
		mutate func(*runsmodels.PoolWorkReceipt)
	}{
		{"其他任务", func(value *runsmodels.PoolWorkReceipt) { value.TaskID = "foreign" }},
		{"其他会话", func(value *runsmodels.PoolWorkReceipt) { value.SessionID = "old-session" }},
		{"其他执行", func(value *runsmodels.PoolWorkReceipt) { value.ExecutionID = "old-execution" }},
		{"旧回合", func(value *runsmodels.PoolWorkReceipt) { value.TurnID = "old-turn" }},
		{"后继 generation", func(value *runsmodels.PoolWorkReceipt) { value.PromptGeneration = 2 }},
		{"欢迎消息不是工作", func(value *runsmodels.PoolWorkReceipt) { value.StartedSource = "welcome" }},
		{"错误 operation", func(value *runsmodels.PoolWorkReceipt) { value.OperationID = "other-operation" }},
	} {
		t.Run(test.name, func(t *testing.T) {
			snapshot := receiptSnapshot(t, false)
			mutateWorkReceipt(t, snapshot, test.mutate)
			page, err := Project(snapshot)
			require.NoError(t, err)
			require.Len(t, page.Items, 1)
			require.Equal(t, "unknown", page.Items[0].State)
			require.Nil(t, page.Items[0].StartedAt)
		})
	}
}

func TestPoolHistoryReceiptPreservesOldWorkButDoesNotCallItCurrent(t *testing.T) {
	snapshot := receiptSnapshot(t, false)
	snapshot.LatestEntryID = 2
	page, err := Project(snapshot)
	require.NoError(t, err)
	require.NotNil(t, page.Items[0].StartedAt)
	require.False(t, page.Items[0].Current)
	require.Equal(t, "unknown", page.Items[0].State)
}

func TestPoolHistoryReceiptFinishedRequiresBothNativeStopAndFinishedFact(t *testing.T) {
	for _, mode := range []string{"正常终结", "缺少终结", "资源释放未确认", "native 行不是终结"} {
		t.Run(mode, func(t *testing.T) {
			snapshot := receiptSnapshot(t, true)
			switch mode {
			case "缺少终结":
				snapshot.Events = snapshot.Events[:len(snapshot.Events)-1]
			case "资源释放未确认":
				for _, event := range snapshot.Events {
					if event.EventType != runsmodels.PoolExecutionStopped {
						continue
					}
					var stopped runsmodels.PoolExecutionStopReceipt
					require.NoError(t, json.Unmarshal([]byte(event.Payload), &stopped))
					stopped.ExecutionActivityReleased = false
					encoded, err := json.Marshal(stopped)
					require.NoError(t, err)
					event.Payload = string(encoded)
				}
			case "native 行不是终结":
				snapshot.Runs[0].Status = runsmodels.RunStatusClaimed
			}
			page, err := Project(snapshot)
			require.NoError(t, err)
			if mode == "正常终结" {
				require.Equal(t, "ended", page.Items[0].State)
				require.NotNil(t, page.Items[0].EndedAt)
			} else {
				require.Equal(t, "unknown", page.Items[0].State)
				if mode == "资源释放未确认" {
					require.NotNil(t, page.Items[0].StartedAt, "后续终结证据不完整不能抹掉已确认的开工事实")
				}
			}
		})
	}
}
