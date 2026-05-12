import json

from rocketlib import Entry, IInstanceBase

from .IGlobal import IGlobal
from .logic import run_operation


class IInstance(IInstanceBase):
    IGlobal: IGlobal
    text: str = ""

    def open(self, _object: Entry):
        self.text = ""

    def writeText(self, text: str):
        self.text += text
        return self.preventDefault()

    def writeTable(self, table: str):
        self.text += table
        return self.preventDefault()

    def closing(self):
        output = run_operation(self.IGlobal.operation, self.text)
        self.instance.writeText(json.dumps(output, separators=(",", ":"), sort_keys=True))

    def close(self):
        self.text = ""
