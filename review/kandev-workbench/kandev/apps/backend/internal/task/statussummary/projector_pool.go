package statussummary

import (
	"context"

	"go.uber.org/zap"

	"github.com/kandev/kandev/internal/events"
)

func summaryEventAllowsMissingTask(kind string) bool {
	return kind == events.MessageQueueStatusChanged || kind == events.TaskPoolExecutionCommitted
}

func isPoolSummaryRefreshEvent(kind string) bool {
	switch kind {
	case events.TaskPoolExecutionCommitted, events.TaskCreated, events.TaskUpdated, events.TaskStateChanged:
		return true
	default:
		return false
	}
}

func (p *Projector) restorePoolExecution(ctx context.Context, taskID string, state *projectionState) error {
	if p.loadPoolExecution == nil {
		return nil
	}
	_, err := p.refreshPoolExecution(ctx, taskID, state)
	return err
}

func (p *Projector) refreshPoolExecution(ctx context.Context, taskID string, state *projectionState) (bool, error) {
	value, err := p.loadPoolExecution(ctx, taskID)
	if isMissingTaskLookupErr(err) {
		return false, err
	}
	if err == nil {
		err = validatePoolExecution(value)
	}
	if err != nil {
		p.logger.Warn("池摘要来源不可测", zap.String("task_id", taskID), zap.Error(err))
		recordHandlerFailure()
		value = UnavailablePoolExecution(state.poolExecution)
	}
	before, after := TaskStatusSummary{PoolExecution: state.poolExecution}, TaskStatusSummary{PoolExecution: value}
	changed := state.current == nil || !state.poolExecutionObserved || !before.SemanticEqual(after)
	state.poolExecution, state.poolExecutionObserved = clonePoolExecution(value), true
	return changed, nil
}
