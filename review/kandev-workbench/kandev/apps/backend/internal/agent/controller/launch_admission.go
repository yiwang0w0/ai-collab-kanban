package controller

import (
	"context"

	"github.com/kandev/kandev/internal/agent/runtime/lifecycle"
)

// TaskPreparationAdmission 让独立运行时准备复用任务所有者的原生准入。
type TaskPreparationAdmission interface {
	WithTaskPreparation(context.Context, string, func(context.Context) error) error
}

// SetTaskPreparationAdmission 仅供宿主构造时连接同一任务协调器。
func (c *Controller) SetTaskPreparationAdmission(admission TaskPreparationAdmission) {
	c.preparationAdmission = admission
}

func (c *Controller) launchWithPreparationAdmission(ctx context.Context, request *lifecycle.LaunchRequest) (*lifecycle.AgentExecution, error) {
	if c.preparationAdmission == nil {
		return c.lifecycle.Launch(ctx, request)
	}
	var execution *lifecycle.AgentExecution
	err := c.preparationAdmission.WithTaskPreparation(ctx, request.TaskID, func(admitted context.Context) error {
		var err error
		execution, err = c.lifecycle.Launch(admitted, request)
		return err
	})
	return execution, err
}
