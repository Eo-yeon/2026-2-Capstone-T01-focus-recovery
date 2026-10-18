package com.focusrecovery.support;

import static org.assertj.core.api.Assertions.assertThat;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.function.Function;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;

// 여러 테스트가 함께 쓰는 POST /api/ai/analyses 모의 AI 서버(JDK HttpServer, 실제 AI 서버 아님).
// 응답을 붙잡아 두거나(hold) 지연·연결 끊기를 흉내 낸다
public final class MockAiServer {

	public static final Response DISCONNECT = new Response(-1, "", 0);

	public record Response(int status, String body, long delayMs) {
	}

	public static Response ok(String body) {
		return new Response(200, body, 0);
	}

	private final HttpServer server;
	private final List<String> requests = Collections.synchronizedList(new ArrayList<>());
	private volatile Function<String, Response> responder;
	private volatile CountDownLatch gate = new CountDownLatch(0);

	public MockAiServer() {
		try {
			server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
		} catch (IOException e) {
			throw new IllegalStateException(e);
		}
		server.setExecutor(Executors.newCachedThreadPool());
		server.createContext("/api/ai/analyses", this::handle);
		server.start();
	}

	public String baseUrl() {
		return "http://127.0.0.1:" + server.getAddress().getPort();
	}

	public void reset(Function<String, Response> responder) {
		this.responder = responder;
		requests.clear();
	}

	public void hold() {
		gate = new CountDownLatch(1);
	}

	public void release() {
		gate.countDown();
	}

	public List<String> requests() {
		return List.copyOf(requests);
	}

	public void awaitRequests(int count) throws InterruptedException {
		long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
		while (requests.size() < count && System.nanoTime() < deadline) {
			Thread.sleep(10);
		}
		assertThat(requests).hasSizeGreaterThanOrEqualTo(count);
	}

	private void handle(HttpExchange exchange) throws IOException {
		String body = new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
		if (!"POST".equals(exchange.getRequestMethod())) {
			exchange.sendResponseHeaders(405, -1);
			return;
		}
		requests.add(body);
		Response response = responder.apply(body);
		try {
			gate.await(10, TimeUnit.SECONDS);
			Thread.sleep(response.delayMs());
		} catch (InterruptedException e) {
			Thread.currentThread().interrupt();
		}
		if (response == DISCONNECT) {
			exchange.close();
			return;
		}
		byte[] bytes = response.body().getBytes(StandardCharsets.UTF_8);
		exchange.getResponseHeaders().add("Content-Type", "application/json");
		try {
			exchange.sendResponseHeaders(response.status(), bytes.length);
			exchange.getResponseBody().write(bytes);
		} catch (IOException e) {
			// 클라이언트가 타임아웃으로 먼저 끊은 경우
		}
		exchange.close();
	}
}
