# SSL Readme

# Generate self signed certificate
openssl genrsa -out private.pem 2048
openssl req -new -x509 -sha256 -key private.pem -out cert.pem -days 365