from anthropic import Anthropic
client = Anthropic()
reply = client.messages.create(model="claude-sonnet-4-5", max_tokens=512, messages=[])
