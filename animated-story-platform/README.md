# Animated Story Video Generation Platform

A modern, production-ready platform for generating animated story videos using the latest Google GenAI SDKs.

## Features

- **Story Generation**: Structured story creation with consistent character management using Gemini
- **Image Generation**: Scene visualization using Imagen 3.0
- **Audio Synthesis**: Narration generation with Gemini Live API  
- **Video Composition**: Automated video creation and assembly
- **Progress Tracking**: Real-time generation progress updates
- **File Management**: Secure downloads and automatic cleanup
- **Docker Support**: Easy deployment with containers

## Architecture

This platform provides two backend implementations:

- **Python Backend** (`backend-python/`): FastAPI-based implementation using `google-genai` SDK
- **Node.js Backend** (`backend-nodejs/`): Express.js-based implementation using `@google/genai` library

Both backends provide identical functionality and RESTful APIs.

## Quick Start

### Python Backend

```bash
cd backend-python
pip install -r requirements.txt
uvicorn main:app --reload
```

### Node.js Backend

```bash
cd backend-nodejs  
npm install
npm start
```

### Docker Deployment

```bash
docker-compose up
```

## API Endpoints

- `POST /api/generate-story` - Generate animated story video
- `GET /api/progress/{task_id}` - Get generation progress
- `GET /api/download/{video_id}` - Download generated video
- `GET /api/health` - Health check

## Configuration

Set these environment variables:

- `GOOGLE_API_KEY` - Your Google AI API key
- `MAX_SCENES` - Maximum scenes per story (default: 5)
- `VIDEO_RESOLUTION` - Output video resolution (default: "1280x720")

## Examples

See the `examples/` directory for usage examples and integrations.

## License

Licensed under the Apache License, Version 2.0. See LICENSE file for details.