package poolhistory

import (
	"encoding/json"

	runsmodels "github.com/kandev/kandev/internal/runs/models"
)

func requeueCause(snapshot *Snapshot, entry Entry, run *runsmodels.Run, event *runsmodels.RunEvent) bool {
	if event == nil || event.EventType != runsmodels.PoolRecoveryRequeued || event.Seq < 0 || event.CreatedAt.IsZero() {
		return false
	}
	var operation runsmodels.PoolRecoveryOperation
	if !decodeReceipt(event.Payload, &operation) {
		return false
	}
	var release struct {
		Release runsmodels.PoolReleaseSnapshot `json:"pool_release"`
	}
	// 原生运行载荷还含任务和代理信封，不使用严格控制回执解码器。
	if json.Unmarshal([]byte(run.Payload), &release) != nil {
		return false
	}
	request := runsmodels.PoolClaimStart{RunID: run.ID, ClaimID: operation.ClaimID, Release: release.Release}
	return operation.ValidExecutionFor(request) && operation.Command.Action == "retry" && operation.FinishedSeq < event.Seq &&
		releaseMatchesEntry(request.Release, snapshot.TaskID, entry) && request.Release.MatchesRun(run)
}

// queueCauseForClaim 以事件先后关系核对本轮排队，不使用领取时间或 UUID 猜测重试。
func queueCauseForClaim(snapshot *Snapshot, entry Entry, run *runsmodels.Run, selection Selection, item Item) Item {
	first, intent, previous := -1, -1, (*runsmodels.RunEvent)(nil)
	for _, event := range snapshot.Events {
		if event == nil || event.RunID != run.ID || event.EventType != runsmodels.PoolLaunchAdmitted {
			continue
		}
		if first < 0 || event.Seq < first {
			first = event.Seq
		}
		var request runsmodels.PoolClaimStart
		if decodeReceipt(event.Payload, &request) && request.ClaimID == selection.ClaimID {
			intent = event.Seq
		}
	}
	if intent < 0 {
		return item
	}
	if intent == first {
		item.QueuedAt = &run.RequestedAt
		return item
	}
	for _, event := range snapshot.Events {
		if event != nil && event.RunID == run.ID && event.Seq < intent && (previous == nil || event.Seq > previous.Seq) {
			previous = event
		}
	}
	if !requeueCause(snapshot, entry, run, previous) {
		item.State, item.Reason, item.QueuedAt = stateUnknown, "queue_cause_unverified", nil
		return item
	}
	item.QueuedAt = &previous.CreatedAt
	return item
}

func projectRequeuedPending(snapshot *Snapshot, entry Entry, run *runsmodels.Run, item Item) Item {
	var last *runsmodels.RunEvent
	for _, event := range snapshot.Events {
		if event != nil && event.RunID == run.ID && (last == nil || event.Seq > last.Seq) {
			last = event
		}
	}
	if snapshot.EvidenceIncomplete || !requeueCause(snapshot, entry, run, last) {
		item.State, item.Reason = stateUnknown, "queue_cause_unverified"
		return item
	}
	item.QueuedAt, item.State, item.Reason = &last.CreatedAt, "queued", ""
	item.Current = entry.ID == snapshot.LatestEntryID && entry.WorkflowID == snapshot.CurrentWorkflowID && entry.StepID == snapshot.CurrentStepID
	return item
}
