package backendapp

import (
	"context"
	"fmt"

	runsservice "github.com/kandev/kandev/internal/runs/service"
	workflowengine "github.com/kandev/kandev/internal/workflow/engine"
)

type taskPoolReleasePublisher interface {
	PublishPoolRelease(context.Context, string, string, string) (runsservice.QueueOutcome, error)
}

func (a *runsServiceEngineAdapter) QueuePoolRun(ctx context.Context, req workflowengine.PoolQueueRequest) (workflowengine.QueueOutcome, error) {
	if a.poolPublisher == nil {
		return workflowengine.QueueOutcomeNone, fmt.Errorf("%w: pool_publisher_unavailable", workflowengine.ErrActionNotYetWired)
	}
	outcome, err := a.poolPublisher.PublishPoolRelease(ctx, req.TaskID, req.WorkflowStepID, req.EntryID)
	return workflowengine.QueueOutcome(outcome), err
}
