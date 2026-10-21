package backendapp

import (
	"os"

	officeservice "github.com/kandev/kandev/internal/office/service"
	"github.com/kandev/kandev/internal/orchestrator"
	runsservice "github.com/kandev/kandev/internal/runs/service"
)

// wireMockPoolRuntime 仅让原生模拟宿主接通本池，生产和混合真实提供商模式保持关闭。
func wireMockPoolRuntime(repos *Repositories, services *Services, coordinator *orchestrator.Service, queue *runsservice.Service, processor *officeservice.Service) {
	if os.Getenv("KANDEV_E2E_MOCK") != "true" || os.Getenv("KANDEV_MOCK_AGENT") != "only" {
		return
	}
	queue.SetPoolReleaseSource(repos.Task)
	queue.SetPoolEnqueueAdmission(coordinator)
	queue.SetPoolProjectionObserver(coordinator.ObservePoolCommit)
	services.Task.SetPoolRunQueue(queue)
	services.Task.SetPoolReleaseAdmission(coordinator)
	coordinator.SetPoolTaskStartGuard(queue)
	processor.SetPoolRunProcessor((&officeOrchestratorTaskStarter{orch: coordinator}).ProcessPoolRun)
}
