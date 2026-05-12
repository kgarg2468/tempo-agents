from rocketlib import IGlobalBase, OPEN_MODE
from ai.common.config import Config


class IGlobal(IGlobalBase):
    operation: str | None = None

    def beginGlobal(self):
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            return

        config = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)
        parameters = config.get("parameters", {}) if isinstance(config, dict) else {}
        self.operation = config.get("operation") or parameters.get("operation")

    def endGlobal(self):
        self.operation = None
