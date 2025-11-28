const dockerHub = "https://registry-1.docker.io";

// 使用 process.env 获取环境变量
const routes = {
  // production
  [`docker.${process.env.CUSTOM_DOMAIN}`]: dockerHub,
  [`quay.${process.env.CUSTOM_DOMAIN}`]: "https://quay.io",
  [`gcr.${process.env.CUSTOM_DOMAIN}`]: "https://gcr.io",
  [`k8s-gcr.${process.env.CUSTOM_DOMAIN}`]: "https://k8s.gcr.io",
  [`k8s.${process.env.CUSTOM_DOMAIN}`]: "https://registry.k8s.io",
  [`ghcr.${process.env.CUSTOM_DOMAIN}`]: "https://ghcr.io",
  [`cloudsmith.${process.env.CUSTOM_DOMAIN}`]: "https://docker.cloudsmith.io",
  [`ecr.${process.env.CUSTOM_DOMAIN}`]: "https://public.ecr.aws",

  // staging
  [`docker-staging.${process.env.CUSTOM_DOMAIN}`]: dockerHub,
};

function routeByHosts(host) {
  if (host in routes) {
    return routes[host];
  }
  if (process.env.MODE === "debug") {
    return process.env.TARGET_UPSTREAM;
  }
  return "";
}

async function handleRequest(request) {
  try {
    const url = new URL(request.url);
    if (url.pathname === "/") {
      return Response.redirect(`${url.protocol}//${url.host}/v2/`, 301);
    }

    const upstream = routeByHosts(url.hostname);
    if (upstream === "") {
      return new Response(
        JSON.stringify({ routes: routes }),
        {
          status: 404,
          headers: { "Content-Type": "application/json" }
        }
      );
    }

    const isDockerHub = upstream === dockerHub;
    const authorization = request.headers.get("Authorization");

    if (url.pathname === "/v2/") {
      const newUrl = new URL(`${upstream}/v2/`);
      const headers = new Headers(request.headers);
      // 可以在这里添加或修改 headers

      // 检查是否需要身份验证
      const resp = await fetch(newUrl.toString(), {
        method: "GET",
        headers: headers,
        // Bun 的 fetch 目前不支持 redirect: 'manual'
      });

      if (resp.status === 401) {
        return responseUnauthorized(url);
      }
      return resp;
    }

    // 获取 token
    if (url.pathname === "/v2/auth") {
      const newUrl = new URL(`${upstream}/v2/`);
      const resp = await fetch(newUrl.toString(), { method: "GET" });

      if (resp.status !== 401) {
        return resp;
      }

      const authenticateStr = resp.headers.get("WWW-Authenticate");
      if (authenticateStr === null) {
        return resp;
      }

      const wwwAuthenticate = parseAuthenticate(authenticateStr);
      let scope = url.searchParams.get("scope");

      // 为 DockerHub library 镜像自动补全 repo 部分
      if (scope && isDockerHub) {
        const scopeParts = scope.split(":");
        if (scopeParts.length === 3 && !scopeParts[1].includes("/")) {
          scopeParts[1] = `library/${scopeParts[1]}`;
          scope = scopeParts.join(":");
        }
      }

      return await fetchToken(wwwAuthenticate, scope, authorization);
    }

    // 为 DockerHub library 镜像重定向路径
    if (isDockerHub) {
      const pathParts = url.pathname.split("/");
      // 匹配 /v2/<repo>/<something> 格式, 例如 /v2/busybox/manifests/latest
      if (pathParts.length >= 4 && pathParts[2] && !pathParts[2].includes("/")) {
        pathParts.splice(2, 0, "library");
        const redirectUrl = new URL(url);
        redirectUrl.pathname = pathParts.join("/");
        return Response.redirect(redirectUrl, 301);
      }
    }

    // 转发请求
    const newUrl = new URL(`${upstream}${url.pathname}${url.search}`);
    const newReq = new Request(newUrl, {
      method: request.method,
      headers: request.headers,
      body: request.body, // 转发请求体
      // Bun 的 fetch 不支持 'manual'，我们需要自己处理重定向
    });

    let resp = await fetch(newReq);

    // 处理 DockerHub blob 的 307 重定向
    if (isDockerHub && [307, 302, 301].includes(resp.status)) {
      const location = resp.headers.get("Location");
      if (location) {
        // 手动跟随重定向
        resp = await fetch(location, {
          method: "GET",
          headers: request.headers, // 可能需要传递原始 headers，如 Authorization
        });
      }
    }

    if (resp.status === 401) {
      return responseUnauthorized(url);
    }

    return resp;
  } catch (error) {
    console.error("Error handling request:", error);
    return new Response("Internal Server Error", { status: 500 });
  }
}

function parseAuthenticate(authenticateStr) {
  // 示例: Bearer realm="https://auth.ipv6.docker.com/token",service="registry.docker.io"
  // 匹配 =" 和 " 之间的字符串
  const re = /(?<=\=")(?:\\.|[^"\\])*(?=")/g;
  const matches = authenticateStr.match(re);
  if (matches == null || matches.length < 2) {
    throw new Error(`无效的 Www-Authenticate 头部: ${authenticateStr}`);
  }
  return {
    realm: matches[0],
    service: matches[1],
  };
}

async function fetchToken(wwwAuthenticate, scope, authorization) {
  const url = new URL(wwwAuthenticate.realm);
  if (wwwAuthenticate.service) {
    url.searchParams.set("service", wwwAuthenticate.service);
  }
  if (scope) {
    url.searchParams.set("scope", scope);
  }

  const headers = new Headers();
  if (authorization) {
    headers.set("Authorization", authorization);
  }

  return await fetch(url.toString(), { method: "GET", headers: headers });
}

function responseUnauthorized(url) {
  const headers = new Headers();
  const realmHost = process.env.MODE === "debug" ? url.host : url.hostname;
  headers.set(
    "Www-Authenticate",
    `Bearer realm="${url.protocol}//${realmHost}/v2/auth",service="cloudflare-docker-proxy"`
  );
  return new Response(JSON.stringify({ message: "UNAUTHORIZED" }), {
    status: 401,
    headers: headers,
  });
}

// 启动 Bun 服务器
Bun.serve({
  port: process.env.PORT || 3000, // 从环境变量获取端口，默认 3000
  hostname: "0.0.0.0", // 监听所有网络接口
  fetch: handleRequest,
});

console.log(`Bun.js Docker Proxy is running on http://0.0.0.0:${process.env.PORT || 3000}`);