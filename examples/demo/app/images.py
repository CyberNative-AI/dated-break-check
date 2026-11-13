from openai import OpenAI
client = OpenAI()
img = client.images.generate(model="gpt-image-1", prompt="a chart")
