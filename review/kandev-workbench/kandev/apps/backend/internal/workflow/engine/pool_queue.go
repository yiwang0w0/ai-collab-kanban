package engine

import (
	"context"
	"fmt"
)

// PoolQueueRequest 只携带原生阶段身份；执行者、批准者和时间必须由宿主重新读取。
type PoolQueueRequest struct {
	TaskID         string
	WorkflowStepID string
	EntryID        string
}

type PoolRunQueueAdapter interface {
	QueuePoolRun(context.Context, PoolQueueRequest) (QueueOutcome, error)
}

func (c QueueRunCallback) executePoolQueue(ctx context.Context, in ActionInput) (ActionResult, error) {
	if in.Trigger != TriggerOnEnter || in.State.TaskID == "" || in.Step.ID == "" || in.EntryID == "" {
		return ActionResult{}, fmt.Errorf("pool_release_identity_required")
	}
	publisher, ok := c.Adapter.(PoolRunQueueAdapter)
	if !ok {
		return ActionResult{}, fmt.Errorf("%w: pool_publisher_unavailable", ErrActionNotYetWired)
	}
	outcome, err := publisher.QueuePoolRun(ctx, PoolQueueRequest{TaskID: in.State.TaskID, WorkflowStepID: in.Step.ID, EntryID: in.EntryID})
	if err != nil {
		return ActionResult{}, err
	}
	if outcome != QueueOutcomeQueued && outcome != QueueOutcomeDeduped {
		return ActionResult{}, fmt.Errorf("pool_release_outcome_unconfirmed")
	}
	return ActionResult{}, nil
}
