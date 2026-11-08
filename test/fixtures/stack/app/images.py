from openai import OpenAI

client = OpenAI()
result = client.images.generate(model="gpt-image-1.5", prompt="a lighthouse")
