pipeline {
    agent none

    options {
        disableConcurrentBuilds()
    }

    triggers {
        pollSCM('H/2 * * * *')
    }

    stages {
        stage('Checkout') {
            agent any
            steps {
                git branch: 'main',
                    url: 'https://github.com/VahaC/vahac-games.git'
                stash includes: '**', name: 'source'
            }
        }

        stage('Test') {
            agent {
                docker { image 'node:20-alpine' }
            }
            steps {
                unstash 'source'
                sh 'npm install'
                sh 'npm test'
            }
        }
    }

    post {
        failure {
            node('built-in') {
                withCredentials([
                    string(credentialsId: 'telegram-bot-token', variable: 'TG_TOKEN'),
                    string(credentialsId: 'telegram-chat-id', variable: 'TG_CHAT')
                ]) {
                    sh '''
                        curl -s -X POST https://api.telegram.org/bot${TG_TOKEN}/sendMessage \
                          -d chat_id=${TG_CHAT} \
                          -d text="❌ vahac-games build FAILED: ${JOB_NAME} #${BUILD_NUMBER}
${BUILD_URL}"
                    '''
                }
            }
        }
    }
}
